import { afterEach, describe, expect, it } from "@jest/globals";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { buildTar, buildZip } from "./fixtures.js";

// 全链路集成测试：本地 mock jira server（127.0.0.1，不出本机、无真实网络）模拟
// 表单登录 → getIssue → 附件下载；程序跑构建产物（真实子进程），工作区用临时目录。

interface SeenRequest {
  method: string;
  path: string;
  authorization?: string;
  cookie?: string;
}

/** 可变的 mock 行为：测试拿到 baseUrl 后再填 issueBody / attachmentBytes */
interface MockBehavior {
  issueStatus?: number; // getIssue HTTP 状态；缺省 200
  issueBody?: unknown; // getIssue 响应 JSON
  attachmentBytes?: Record<string, Buffer>; // URL path → bytes；未登记 path 回 404
  issue401Once?: boolean; // getIssue 首次请求回 401（验证 401 重登自愈）
}

interface MockJira {
  baseUrl: string;
  behavior: MockBehavior;
  state: { loginCount: number; requests: SeenRequest[] };
  close: () => void;
}

function startMockJira(): Promise<MockJira> {
  const behavior: MockBehavior = {};
  const state = { loginCount: 0, requests: [] as SeenRequest[] };
  let issue401Consumed = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    state.requests.push({
      method: req.method ?? "",
      path: url.pathname,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });

    if (req.method === "GET" && url.pathname === "/login.jsp") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<html><body><form id="login-form" action="/login.jsp" method="post">' +
          '<input type="hidden" name="atl_token" value="tok"/>' +
          "</form></body></html>",
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/login.jsp") {
      state.loginCount += 1;
      res.writeHead(302, {
        location: "/secure/Dashboard.jspa",
        "set-cookie": `JSESSIONID=sess${state.loginCount}; Path=/`,
      });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/secure/Dashboard.jspa") {
      res.writeHead(200, { "x-ausername": "bot", "content-type": "text/html" });
      res.end("<html>ok</html>");
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/rest/api/2/issue/")) {
      if (behavior.issue401Once && !issue401Consumed) {
        issue401Consumed = true;
        res.writeHead(401);
        res.end();
        return;
      }
      const status = behavior.issueStatus ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify(behavior.issueBody ?? {}) : "{}");
      return;
    }
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/secure/attachment/")
    ) {
      const bytes = behavior.attachmentBytes?.[url.pathname];
      if (bytes === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(bytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        behavior,
        state,
        close: () => server.close(),
      });
    });
  });
}

function makeIssueBody(
  baseUrl: string,
  attachments: { id: string; filename: string; path: string }[],
): unknown {
  return {
    key: "HIM-1",
    fields: {
      summary: "登录失败，联系 zhangsan@corp.example.com",
      description:
        "复现见附件日志。token: abc123secret 请联系 reporter@example.com",
      customfield_11901: "bug 内容，手机 13912345678",
      customfield_11900: "需求内容",
      customfield_11906: "测试范围",
      versions: [{ name: "4.19.1" }],
      fixVersions: [{ name: "4.19.2" }],
      status: { name: "Open", statusCategory: { key: "new", name: "New" } },
      issuetype: { name: "Bug" },
      priority: { name: "Major" },
      updated: "2026-11-12T10:00:00.000+0800",
      reporter: {
        name: "reporter1",
        key: "reporter1",
        displayName: "报告人",
        emailAddress: "reporter@example.com",
      },
      assignee: {
        name: "assignee1",
        key: "assignee1",
        displayName: "处理人",
        emailAddress: "assignee@example.com",
      },
      attachment: attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: "application/octet-stream",
        size: 1, // 声明 size 故意不准：限额按下载后的实际字节数校验
        created: "2026-11-12T09:00:00.000+0800",
        content: `${baseUrl}${a.path}`,
      })),
    },
  };
}

/** 必须异步执行：mock server 与本测试同进程，同步 exec 会阻塞事件循环导致请求饿死 */
function runTool(envelope: unknown): Promise<{
  code: number;
  result: { ok: boolean; output?: any; reason?: string };
}> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["dist/programs/jira-log-fetch.js"],
      {
        encoding: "utf8",
        // 子程序成功路径 exit 0；sdk.fail 路径 exit 1（stdout 仍有结果 JSON）
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        const child = error as (Error & { code?: number }) | null;
        const out = typeof stdout === "string" ? stdout : "";
        let result: { ok: boolean; output?: any; reason?: string };
        try {
          result = JSON.parse(out.trim().split("\n").at(-1)!);
        } catch {
          reject(
            new Error(
              `子程序输出无法解析（exit=${child?.code}）：${out.slice(-500)}`,
            ),
          );
          return;
        }
        resolve({ code: child?.code ?? 0, result });
      },
    ).stdin!.end(JSON.stringify(envelope));
  });
}

const GW_BASIC = `Basic ${Buffer.from("gw-u:gw-p").toString("base64")}`;

function makeConfig(baseUrl: string, extra: Record<string, string> = {}) {
  return {
    jira_url: baseUrl,
    username: "bot",
    password: "secret-pw",
    redirect_username: "gw-u",
    redirect_password: "gw-p",
    ...extra,
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(): Promise<{ jira: MockJira; workspace: string }> {
  const jira = await startMockJira();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jira-log-fetch-"));
  cleanups.push(() => {
    jira.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return { jira, workspace };
}

describe("全链路：登录 → getIssue → 附件下载 → 解包归一 → 脱敏落盘", () => {
  it("混合附件：白名单筛选 + 限额 + 解包 + 脱敏 + identity 旁路", async () => {
    const { jira, workspace } = await setup();
    jira.behavior.issueBody = makeIssueBody(jira.baseUrl, [
      { id: "1", filename: "app.log", path: "/secure/attachment/1/app.log" },
      {
        id: "2",
        filename: "screenshot.png",
        path: "/secure/attachment/2/s.png",
      },
      { id: "3", filename: "pack.zip", path: "/secure/attachment/3/pack.zip" },
      {
        id: "4",
        filename: "single.log.gz",
        path: "/secure/attachment/4/s.log.gz",
      },
      {
        id: "5",
        filename: "bundle.tar.gz",
        path: "/secure/attachment/5/b.tar.gz",
      },
      { id: "6", filename: "noext", path: "/secure/attachment/6/noext" },
      { id: "7", filename: "huge.log", path: "/secure/attachment/7/huge.log" },
      {
        id: "8",
        filename: "ghost.log",
        path: "/secure/attachment/8/ghost.log",
      },
    ]);
    jira.behavior.attachmentBytes = {
      "/secure/attachment/1/app.log": Buffer.from("line1\r\nline2"),
      "/secure/attachment/3/pack.zip": buildZip([
        { name: "a.log", data: Buffer.from("zip-a"), method: 0 },
        { name: "b.txt", data: Buffer.from("zip-b"), method: 8 },
        { name: "inner.png", data: Buffer.from("png"), method: 0 },
      ]),
      "/secure/attachment/4/s.log.gz": zlib.gzipSync(Buffer.from("gz-body")),
      "/secure/attachment/5/b.tar.gz": zlib.gzipSync(
        buildTar([{ name: "t.log", data: Buffer.from("tar-t") }]),
      ),
      "/secure/attachment/6/noext": Buffer.from("raw-text"),
      "/secure/attachment/7/huge.log": Buffer.alloc(1024 * 1024 + 1, "x"),
      // ghost.log 故意不登记字节 → 404 → download-failed
    };

    const { code, result } = await runTool({
      contract_version: "v1",
      input: { issue_key: "HIM-1" },
      config: makeConfig(jira.baseUrl, { max_file_mb: "1" }),
      workspace,
    });

    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    const output = result.output;

    // 契约顶层：status/data/identity
    expect(output.status).toBe("success");
    expect(output.identity).toEqual({
      reporterEmail: "reporter@example.com",
      reporterName: "reporter1",
      assigneeEmail: "assignee@example.com",
      assigneeName: "assignee1",
    });

    // data.issue：脱敏白名单快照（§7 字段清单）
    const issue = output.data.issue;
    expect(issue.key).toBe("HIM-1");
    expect(issue.status).toBe("Open");
    expect(issue.statusCategory).toBe("New");
    expect(issue.issueType).toBe("Bug");
    expect(issue.priority).toBe("Major");
    expect(issue.updated).toBe("2026-11-12T10:00:00.000+0800");
    expect(issue.versions).toEqual(["4.19.1"]);
    expect(issue.fixVersions).toEqual(["4.19.2"]);
    // 脱敏生效：原始邮箱/token/手机号不出现，identity 字段不混进 data
    const issueText = JSON.stringify(issue);
    expect(issueText).not.toContain("reporter@example.com");
    expect(issueText).not.toContain("assignee@example.com");
    expect(issueText).not.toContain("zhangsan@corp.example.com");
    expect(issueText).not.toContain("abc123secret");
    expect(issueText).not.toContain("13912345678");
    expect(issueText).toContain("[ACCOUNT_");
    expect(issue.description).toContain("token: [REDACTED]");
    expect(issueText).not.toContain("secret-pw");
    expect(issueText).not.toContain("gw-p");

    // 落盘快照 = 返回的脱敏快照；无原始邮箱、无凭据
    const snapshotPath = path.join(workspace, "input", "jira-issue.json");
    expect(fs.existsSync(snapshotPath)).toBe(true);
    const snapshotText = fs.readFileSync(snapshotPath, "utf8");
    expect(JSON.parse(snapshotText)).toEqual(issue);
    expect(snapshotText).not.toContain("reporter@example.com");
    expect(snapshotText).not.toContain("secret-pw");
    expect(snapshotText).not.toContain("gw-p");

    // logs：选中的文件（含解包产物），skipped：各类跳过原因
    expect(output.data.logs).toEqual([
      { file: "app.log", size: 12, source_attachment: "app.log" },
      { file: "a.log", size: 5, source_attachment: "pack.zip" },
      { file: "b.txt", size: 5, source_attachment: "pack.zip" },
      { file: "single.log", size: 7, source_attachment: "single.log.gz" },
      { file: "t.log", size: 5, source_attachment: "bundle.tar.gz" },
      { file: "noext", size: 8, source_attachment: "noext" },
    ]);
    expect(output.data.skipped).toEqual([
      { filename: "screenshot.png", reason: "unsupported-extension" },
      { filename: "inner.png", reason: "unsupported-extension" },
      {
        filename: "huge.log",
        reason: expect.stringMatching(/^file-too-large:/),
      },
      { filename: "ghost.log", reason: "download-failed:ticket_not_found" },
    ]);

    // 落盘日志：编码归一（CRLF → LF）
    const logsDir = path.join(workspace, "input", "logs");
    expect(fs.readFileSync(path.join(logsDir, "app.log"), "utf8")).toBe(
      "line1\nline2",
    );
    expect(fs.readFileSync(path.join(logsDir, "t.log"), "utf8")).toBe("tar-t");

    // 认证链：登录一次（cookie 罐复用）；网关 Basic 头每个请求都带
    expect(jira.state.loginCount).toBe(1);
    expect(
      jira.state.requests.some((r) => r.path === "/rest/api/2/issue/HIM-1"),
    ).toBe(true);
    expect(jira.state.requests.every((r) => r.authorization === GW_BASIC)).toBe(
      true,
    );
  });

  it("空日志是合法成功：无附件工单 → logs:[] 且快照照常落盘", async () => {
    const { jira, workspace } = await setup();
    jira.behavior.issueBody = makeIssueBody(jira.baseUrl, []);

    const { code, result } = await runTool({
      contract_version: "v1",
      input: { issue_key: "HIM-1" },
      config: makeConfig(jira.baseUrl),
      workspace,
    });

    expect(code).toBe(0);
    expect(result.output.status).toBe("success");
    expect(result.output.data.logs).toEqual([]);
    expect(result.output.data.skipped).toEqual([]);
    expect(
      fs.existsSync(path.join(workspace, "input", "jira-issue.json")),
    ).toBe(true);
  });

  it("工单不存在 → error 双态（exit 0，output.status=error/ticket_not_found，不走 sdk.fail）", async () => {
    const { jira, workspace } = await setup();
    jira.behavior.issueStatus = 404;

    const { code, result } = await runTool({
      contract_version: "v1",
      input: { issue_key: "HIM-1" },
      config: makeConfig(jira.baseUrl),
      workspace,
    });

    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.output.status).toBe("error");
    expect(result.output.code).toBe("ticket_not_found");
  });

  it("getIssue 首次 401 → 清会话重登一次后成功", async () => {
    const { jira, workspace } = await setup();
    jira.behavior.issue401Once = true;
    jira.behavior.issueBody = makeIssueBody(jira.baseUrl, []);

    const { code, result } = await runTool({
      contract_version: "v1",
      input: { issue_key: "HIM-1" },
      config: makeConfig(jira.baseUrl),
      workspace,
    });

    expect(code).toBe(0);
    expect(result.output.status).toBe("success");
    expect(jira.state.loginCount).toBe(2);
  });

  it("累计限额：第二个附件超限跳过并记原因", async () => {
    const { jira, workspace } = await setup();
    jira.behavior.issueBody = makeIssueBody(jira.baseUrl, [
      { id: "1", filename: "f1.log", path: "/secure/attachment/1/f1.log" },
      { id: "2", filename: "f2.log", path: "/secure/attachment/2/f2.log" },
    ]);
    // 各 600KB：单文件都过 1MB，累计 1.2MB 超 1MB 总额
    jira.behavior.attachmentBytes = {
      "/secure/attachment/1/f1.log": Buffer.alloc(600 * 1024, "a"),
      "/secure/attachment/2/f2.log": Buffer.alloc(600 * 1024, "b"),
    };

    const { code, result } = await runTool({
      contract_version: "v1",
      input: { issue_key: "HIM-1" },
      config: makeConfig(jira.baseUrl, {
        max_file_mb: "1",
        max_total_mb: "1",
      }),
      workspace,
    });

    expect(code).toBe(0);
    expect(result.output.status).toBe("success");
    expect(result.output.data.logs.map((f: any) => f.file)).toEqual(["f1.log"]);
    expect(result.output.data.skipped).toEqual([
      {
        filename: "f2.log",
        reason: expect.stringMatching(/^aggregate-limit-exceeded:/),
      },
    ]);
  });

  it("workspace_subdir 自定义 → 落盘到 {workspace}/{subdir}/", async () => {
    const { jira, workspace } = await setup();
    jira.behavior.issueBody = makeIssueBody(jira.baseUrl, [
      { id: "1", filename: "app.log", path: "/secure/attachment/1/app.log" },
    ]);
    jira.behavior.attachmentBytes = {
      "/secure/attachment/1/app.log": Buffer.from("x"),
    };

    const { code, result } = await runTool({
      contract_version: "v1",
      input: { issue_key: "HIM-1", workspace_subdir: "custom" },
      config: makeConfig(jira.baseUrl),
      workspace,
    });

    expect(code).toBe(0);
    expect(result.output.status).toBe("success");
    expect(
      fs.existsSync(path.join(workspace, "custom", "jira-issue.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(workspace, "custom", "logs", "app.log")),
    ).toBe(true);
  });
});
