/** easemob jira 客户端（jira-log-fetch 工具本地版）：表单登录认证链（cookie 罐 + 401 自愈
 *  重登）+ 工单白名单快照读取 + 附件二进制下载。
 *  认证链移植自平台共享包 packages/jira-client（审查业务 jira-fetch 工具同款实现），
 *  行为不变：login.jsp 表单解析 → 跟随重定向 → Dashboard 匿名态验证；401 视为会话过期，
 *  清登录态重登后原请求重试一次。可选网关 Basic（配置后每个请求带 Authorization 头，
 *  easemob jira 前置网关反代漏传会被 401 拦在 jira 之外）。
 *  与平台版的差异（按 sdk-log-analysis spec §7 补齐）：
 *  - getIssue：只取白名单字段（snapshot 所需 + 附件元数据），不取 comments / changelog
 *    （控量防杂讯），映射为脱敏就绪的快照 Record；
 *  - downloadAttachment：认证态二进制下载（文本原语会损坏二进制字节），按实际字节数返回，
 *    限额校验由调用方按 buffer.byteLength 执行；
 *  - 删除本工具用不到的 search / addComment / createIssue / ping（少即是稳）。
 *  实例持有 cookie 与登录态，调用方控生命周期；类内零 process.env、零全局状态、零三方依赖
 *  （node 24 全局 fetch）。错误模型 = 双态结果 JiraResult<T>：不抛异常、不打日志（调用方各自记）。 */

/** 客户端配置 */
export interface JiraClientConfig {
  /** jira 站点根地址（尾部斜杠内部去掉） */
  baseUrl: string;
  /** 表单登录用户名（os_username） */
  username: string;
  /** 表单登录密码（os_password） */
  password: string;
  /** 网关 Basic 账号（可选；配置后每个请求带 Authorization 头） */
  redirectUsername?: string;
  /** 网关 Basic 密码 */
  redirectPassword?: string;
  /** 单请求超时毫秒；缺省 30000 */
  timeoutMs?: number;
}

/** 失败错误码 */
export type JiraErrorCode =
  | "invalid_input" // 入参非法（空请求路径、空 issueKey 等）
  | "authentication_failed" // 登录失败 / 401 重登后仍 401
  | "permission_denied" // 403
  | "ticket_not_found" // 404
  | "rate_limited" // 429
  | "jira_server_error" // 5xx
  | "network_error" // 连接失败 / 超时中止
  | "invalid_response"; // 非预期响应形状（非法 JSON、缺预期字段、未列举的状态码）

/** 双态结果：jira 错误是调用方可判别的正常输出 */
export type JiraResult<T> =
  | { status: "success"; data: T }
  | { status: "error"; code: JiraErrorCode; message: string };

/** identity 旁路（脱敏前提取；不进入 data，用于通知 @ 人） */
export interface IssueIdentity {
  reporterEmail?: string;
  reporterName?: string;
  assigneeEmail?: string;
  assigneeName?: string;
}

interface Cookie {
  name: string;
  value: string;
}

type FetchTextResult =
  | { status: "success"; response: Response; body: string }
  | { status: "error"; code: JiraErrorCode; message: string };

type FetchBytesResult =
  | { status: "success"; response: Response; body: Buffer }
  | { status: "error"; code: JiraErrorCode; message: string };

/** getIssue 白名单字段（spec §7 快照所需 + 附件元数据 + identity 所需的 reporter/assignee；
 *  不含 comment / changelog；customfield_1190x 是 easemob 私有字段） */
const ISSUE_FIELDS = [
  "summary",
  "description",
  "customfield_11901", // himBugContent
  "customfield_11900", // himRequirementContent
  "customfield_11906", // testScope
  "versions",
  "fixVersions",
  "status",
  "issuetype",
  "priority",
  "updated",
  "attachment",
  "reporter",
  "assignee",
].join(",");

function failure(
  code: JiraErrorCode,
  message: string,
): { status: "error"; code: JiraErrorCode; message: string } {
  return { status: "error", code, message };
}

/** HTTP 状态码 → 错误码映射 */
function mapHttpError(status: number): {
  status: "error";
  code: JiraErrorCode;
  message: string;
} {
  if (status === 401) return failure("authentication_failed", "jira 认证失败");
  if (status === 403) return failure("permission_denied", "jira 权限不足");
  if (status === 404) return failure("ticket_not_found", "jira 工单不存在");
  if (status === 429) return failure("rate_limited", "jira 限流");
  if (status >= 500) return failure("jira_server_error", "jira 服务端错误");
  return failure("invalid_response", `jira 返回非预期 HTTP 状态: ${status}`);
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** 从登录页 HTML 提取表单：优先 id="login-form" 的 form，退化为第一个 form；
 *  返回 action 绝对地址 + hidden 字段表（含 CSRF token 等，POST 时原样回带） */
function extractLoginForm(
  html: string,
  responseUrl: string,
): { actionUrl: string; hiddenFields: Record<string, string> } | undefined {
  let formMatch: RegExpMatchArray | undefined;
  const formPattern = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  for (const m of html.matchAll(formPattern)) {
    if (/\sid=["']login-form["']/i.test(m[0])) {
      formMatch = m;
      break;
    }
  }
  formMatch ??= /<form\b[^>]*>[\s\S]*?<\/form>/i.exec(html) ?? undefined;
  if (formMatch === undefined) return undefined;

  const actionMatch = /\saction=["']([^"']*)["']/i.exec(formMatch[0]);
  const actionUrl = new URL(
    actionMatch?.[1] ?? "/login.jsp",
    responseUrl,
  ).toString();
  const hiddenFields: Record<string, string> = {};
  const hiddenInputPattern = /<input\b[^>]*type=["']hidden["'][^>]*>/gi;
  for (const inputMatch of formMatch[0].matchAll(hiddenInputPattern)) {
    const input = inputMatch[0];
    const name = /\sname=["']([^"']+)["']/i.exec(input)?.[1];
    if (name === undefined) continue;
    hiddenFields[name] = /\svalue=["']([^"']*)["']/i.exec(input)?.[1] ?? "";
  }
  return { actionUrl, hiddenFields };
}

/** 判定响应是否「匿名态」（登录失败的判据）：x-ausername 头优先，退化为页面特征 */
function isAnonymous(response: Response, body: string): boolean {
  const headerUser = response.headers.get("x-ausername")?.trim().toLowerCase();
  if (headerUser === "anonymous") return true;
  if (headerUser) return false;
  const remoteUser =
    /<meta\s+name=["']ajs-remote-user["']\s+content=["']([^"']*)["']/i.exec(
      body,
    );
  if (remoteUser !== null) {
    return remoteUser[1]?.trim() === "";
  }
  const lowered = body.toLowerCase();
  return lowered.includes('name="os_username"');
}

/** 收集 Set-Cookie 头（node fetch 的 Headers 带 getSetCookie） */
function collectSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  if (getSetCookie) return getSetCookie.call(headers);
  const value = headers.get("set-cookie");
  if (value === null) return [];
  return value
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function parseSetCookie(value: string): Cookie | undefined {
  const pair = value.split(";")[0] ?? "";
  const separator = pair.indexOf("=");
  if (separator <= 0) return undefined;
  return {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
  };
}

/** 过滤空值请求头（如无 cookie 时的空 Cookie 头，避免发出 `Cookie: ` 空串） */
function withoutEmptyHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== ""),
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/** 取带 name 字段对象的展示名（status/priority/issuetype/statusCategory 通用） */
function readNamedValue(value: unknown): string | undefined {
  const record = toRecord(value);
  return (
    readString(record.name) ??
    readString(record.key) ??
    readString(record.displayName)
  );
}

function readNamedArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(readNamedValue)
    .filter((item): item is string => Boolean(item));
}

/** 读用户对象为扁平 Record（name/key/displayName/emailAddress 有值才带），供脱敏与 identity 旁路 */
function readUser(value: unknown): Record<string, string> | undefined {
  const record = toRecord(value);
  const user: Record<string, string> = {};
  const name = readString(record.name);
  const key = readString(record.key);
  const displayName = readString(record.displayName);
  const emailAddress = readString(record.emailAddress);

  if (name) {
    user.name = name;
  }
  if (key) {
    user.key = key;
  }
  if (displayName) {
    user.displayName = displayName;
  }
  if (emailAddress) {
    user.emailAddress = emailAddress;
  }

  return Object.keys(user).length > 0 ? user : undefined;
}

/** 读附件元数据（content = 下载地址；字节数限额以下载后的实际字节数为准，size 仅供参考） */
function readAttachments(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const record = toRecord(item);
    return {
      id: readString(record.id),
      filename: readString(record.filename),
      mimeType: readString(record.mimeType),
      size: typeof record.size === "number" ? record.size : undefined,
      created: readString(record.created),
      content: readString(record.content),
    };
  });
}

/** 原始 jira issue JSON → 脱敏就绪的白名单快照（字段集见 spec §7 data；不含 comments/changelog） */
function mapIssueSnapshot(
  data: Record<string, unknown>,
  fallbackKey: string,
): Record<string, unknown> {
  const fields = toRecord(data.fields);
  return {
    key: readString(data.key) ?? fallbackKey,
    summary: readString(fields.summary) ?? "",
    description: readString(fields.description),
    himBugContent: readString(fields.customfield_11901),
    himRequirementContent: readString(fields.customfield_11900),
    testScope: readString(fields.customfield_11906),
    versions: readNamedArray(fields.versions),
    fixVersions: readNamedArray(fields.fixVersions),
    status: readNamedValue(fields.status),
    // statusCategory（New / In Progress / Complete）是终态判断依据（spec §4.3）
    statusCategory: readNamedValue(toRecord(fields.status).statusCategory),
    issueType: readNamedValue(fields.issuetype),
    priority: readNamedValue(fields.priority),
    updated: readString(fields.updated),
    reporter: readUser(fields.reporter),
    assignee: readUser(fields.assignee),
    attachments: readAttachments(fields.attachment),
  };
}

/** 从快照中提取 reporter/assignee 的原始身份（须在脱敏前调用；不进 data 的旁路数据） */
export function extractIdentity(issue: Record<string, unknown>): IssueIdentity {
  const reporter = toRecord(issue.reporter);
  const assignee = toRecord(issue.assignee);
  return {
    reporterEmail: readString(reporter.emailAddress),
    reporterName: readString(reporter.name),
    assigneeEmail: readString(assignee.emailAddress),
    assigneeName: readString(assignee.name),
  };
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly redirectUsername?: string;
  private readonly redirectPassword?: string;
  private readonly timeoutMs: number;
  private cookies: Cookie[] = [];
  private authenticated = false;

  constructor(config: JiraClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
    this.redirectUsername = config.redirectUsername;
    this.redirectPassword = config.redirectPassword;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  /** 拉工单白名单快照：GET /rest/api/2/issue/{key}?fields=<白名单>；
   *  404 → ticket_not_found；响应非工单对象 → invalid_response。
   *  成功 data = 未脱敏快照（调用方先 extractIdentity、再 masking、后落盘/返回）。 */
  async getIssue(
    issueKey: string,
  ): Promise<JiraResult<Record<string, unknown>>> {
    if (issueKey.trim() === "") {
      return failure("invalid_input", "issueKey 不能为空");
    }
    const query = new URLSearchParams({ fields: ISSUE_FIELDS });
    const response = await this.fetchAuthed(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}?${query.toString()}`,
      { Accept: "application/json" },
    );
    if (response.status === "error") return response;
    if (!response.response.ok) {
      return mapHttpError(response.response.status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return failure("invalid_response", "jira 响应不是合法 JSON");
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return failure("invalid_response", "jira 响应不是工单对象");
    }
    return {
      status: "success",
      data: mapIssueSnapshot(parsed as Record<string, unknown>, issueKey),
    };
  }

  /** 认证态下载附件二进制：成功 data = 原始字节
   *  （未解包、未归一；实际字节数 = data.byteLength，限额校验归调用方）。
   *  注意：跨主机重定向本实现不跟随（redirect: manual），按 invalid_response 返回。 */
  async downloadAttachment(contentUrl: string): Promise<JiraResult<Buffer>> {
    if (contentUrl.trim() === "") {
      return failure("invalid_input", "附件下载地址不能为空");
    }
    const url = resolveAttachmentUrl(contentUrl, this.baseUrl);
    const response = await this.fetchBytesAuthed(url, {});
    if (response.status === "error") return response;
    if (!response.response.ok) {
      return mapHttpError(response.response.status);
    }
    return { status: "success", data: response.body };
  }

  private cookieHeader(): string {
    return this.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  private storeCookies(headers: Headers): void {
    for (const header of collectSetCookieHeaders(headers)) {
      const cookie = parseSetCookie(header);
      if (cookie === undefined) continue;
      this.cookies = this.cookies.filter(
        (existing) => existing.name !== cookie.name,
      );
      this.cookies.push(cookie);
    }
  }

  /** 网关 Basic 头（配置 redirect 凭据时每个请求都带） */
  private gatewayHeaders(): Record<string, string> {
    if (!this.redirectUsername || !this.redirectPassword) {
      return {};
    }
    return {
      Authorization: `Basic ${Buffer.from(
        `${this.redirectUsername}:${this.redirectPassword}`,
      ).toString("base64")}`,
    };
  }

  /** 底层 fetch（文本）：手动重定向（登录流程要自己看 302），超时中止，网络层失败 → network_error */
  private async fetchText(
    url: string,
    headers: Record<string, string> = {},
    body?: string,
    method?: string,
  ): Promise<FetchTextResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: withoutEmptyHeaders(headers),
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      this.storeCookies(response.headers);
      return { status: "success", response, body: await response.text() };
    } catch (err) {
      return failure(
        "network_error",
        `jira 连接失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 底层 fetch（二进制）：与 fetchText 同纪律，body 读为字节（附件下载用） */
  private async fetchBytes(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<FetchBytesResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: withoutEmptyHeaders(headers),
        redirect: "manual",
        signal: controller.signal,
      });
      this.storeCookies(response.headers);
      return {
        status: "success",
        response,
        body: Buffer.from(await response.arrayBuffer()),
      };
    } catch (err) {
      return failure(
        "network_error",
        `jira 连接失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 表单登录：GET /login.jsp 解析 hidden fields + CSRF → POST os_username/os_password/os_cookie=true
   *  → 跟随一次重定向 → GET /secure/Dashboard.jspa 验证非匿名。成功置 authenticated */
  private async ensureAuthenticated(): Promise<
    { status: "error"; code: JiraErrorCode; message: string } | undefined
  > {
    if (this.authenticated) return undefined;

    const loginPage = await this.fetchText(
      `${this.baseUrl}/login.jsp`,
      this.gatewayHeaders(),
    );
    if (loginPage.status === "error") return loginPage;
    if (!loginPage.response.ok) {
      return mapHttpError(loginPage.response.status);
    }

    const form = extractLoginForm(loginPage.body, `${this.baseUrl}/login.jsp`);
    if (form === undefined) {
      return failure("authentication_failed", "jira 登录页未找到登录表单");
    }

    const payload = new URLSearchParams(form.hiddenFields);
    payload.set("os_username", this.username);
    payload.set("os_password", this.password);
    payload.set("os_cookie", "true");
    if (!payload.get("os_destination")) {
      payload.set("os_destination", "/secure/Dashboard.jspa");
    }

    const loginPost = await this.fetchText(
      form.actionUrl,
      {
        ...this.gatewayHeaders(),
        Cookie: this.cookieHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      payload.toString(),
    );
    if (loginPost.status === "error") return loginPost;
    if (isRedirect(loginPost.response.status)) {
      const location = loginPost.response.headers.get("location");
      if (location === null) return mapHttpError(loginPost.response.status);
      const followed = await this.fetchText(
        new URL(location, form.actionUrl).toString(),
        {
          ...this.gatewayHeaders(),
          Cookie: this.cookieHeader(),
        },
      );
      if (followed.status === "error") return followed;
      if (!followed.response.ok) return mapHttpError(followed.response.status);
    } else if (!loginPost.response.ok) {
      return mapHttpError(loginPost.response.status);
    }

    const verify = await this.fetchText(
      `${this.baseUrl}/secure/Dashboard.jspa`,
      {
        ...this.gatewayHeaders(),
        Cookie: this.cookieHeader(),
      },
    );
    if (verify.status === "error") return verify;
    if (!verify.response.ok) return mapHttpError(verify.response.status);
    if (isAnonymous(verify.response, verify.body)) {
      return failure(
        "authentication_failed",
        "jira 认证失败（登录后仍为匿名态）",
      );
    }

    this.authenticated = true;
    return undefined;
  }

  /** 带会话自愈的认证请求（文本）：401 视为会话过期，清登录态重登后原请求重试一次；再失败按原样返回 */
  private async fetchAuthed(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<FetchTextResult> {
    const once = async (): Promise<FetchTextResult> => {
      const authError = await this.ensureAuthenticated();
      if (authError !== undefined) return authError;
      return this.fetchText(url, {
        ...this.gatewayHeaders(),
        ...headers,
        Cookie: this.cookieHeader(),
      });
    };
    const first = await once();
    if (first.status === "error" || first.response.status !== 401) return first;
    this.authenticated = false;
    this.cookies = [];
    return once();
  }

  /** 带会话自愈的认证请求（二进制）：同 fetchAuthed 的 401 重登重试纪律 */
  private async fetchBytesAuthed(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<FetchBytesResult> {
    const once = async (): Promise<FetchBytesResult> => {
      const authError = await this.ensureAuthenticated();
      if (authError !== undefined) return authError;
      return this.fetchBytes(url, {
        ...this.gatewayHeaders(),
        ...headers,
        Cookie: this.cookieHeader(),
      });
    };
    const first = await once();
    if (first.status === "error" || first.response.status !== 401) return first;
    this.authenticated = false;
    this.cookies = [];
    return once();
  }
}

/** 附件 content 地址解析（纯函数）：站点相对路径按 baseUrl 补全；**同主机 http→https 升级**——
 *  easemob jira 附件元数据返回的是 http content 地址，服务端一律 301 到 https，
 *  而下载链路 redirect:manual 不跟随，301 会变 invalid_response。同主机协议升级等价于
 *  跟随该 301；跨主机/其他重定向仍不跟随（原设计决策不变）。
 *  baseUrl 非 https 或 URL 解析失败时原样返回（异常形状交给请求层归类）。 */
export function resolveAttachmentUrl(
  contentUrl: string,
  baseUrl: string,
): string {
  const trimmed = contentUrl.trim();
  const absolute =
    trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : `${baseUrl.replace(/\/+$/, "")}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
  if (!absolute.startsWith("http://")) {
    return absolute;
  }
  try {
    const target = new URL(absolute);
    const base = new URL(baseUrl);
    if (base.protocol === "https:" && target.host === base.host) {
      return `https://${absolute.slice("http://".length)}`;
    }
  } catch {
    // URL 解析失败：原样返回，交给后续请求按 network_error/invalid_response 归类
  }
  return absolute;
}
