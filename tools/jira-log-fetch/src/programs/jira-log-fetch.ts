import fs from "node:fs";
import path from "node:path";
import { sdk } from "@asteriskzuo/agent-sdk";
import { JiraClient, extractIdentity } from "../jira-client.js";
import { createIssueMasker } from "../masking.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  ingestAttachment,
  isSupportedAttachmentName,
} from "../log-ingest.js";
import type { IngestedLogFile, SkippedItem } from "../log-ingest.js";

// jira-log-fetch 工具入口（sdk-log-analysis spec §7）：
//   jira 认证 + 拉工单白名单快照 + 日志附件筛选/下载/解包/编码归一/落盘 + 脱敏。
// 职责切分：认证/cookie/401 自愈与白名单快照映射在 jira-client.ts；脱敏规则在
// masking.ts（与审查业务同规则）；附件归一化规则在 log-ingest.ts（移植 log-bot）。
// 契约（与流程程序同构的一入一出）：
//   input  = { issue_key, workspace_subdir? }（workspace_subdir 缺省 "input"）；
//   config = { jira_url, username, password, redirect_username?, redirect_password?,
//              max_file_mb?, max_total_mb? }
//   （工具拿不到 secrets，凭据由调用方显式放进 config；
//     redirect_* 为网关 Basic 凭据，jira 前置网关反代时必传，否则被网关 401 拦截；
//     限额缺省 20MB / 100MB）
// workspace：run 工作目录由信封注入（sdk.run 继承父级），落盘 {workspace}/{workspace_subdir}/。
// 成功 sdk.return({ status:'success', data:{ issue:<脱敏快照>, logs, skipped }, identity })；
// jira 层失败走 sdk.return({ status:'error', code, message })——error 双态是业务可判别的
// 正常输出；sdk.fail 只留给信封/参数非法。空日志是合法成功（logs: []）。

const { input, config } = sdk.runInput();
const { workspace } = sdk.input();

const inputRecord = (
  input !== null && typeof input === "object" ? input : {}
) as Record<string, unknown>;

const issueKey = inputRecord.issue_key;
if (typeof issueKey !== "string" || issueKey.trim().length === 0) {
  sdk.fail("input 非法：缺 issue_key（非空字符串）");
}

// workspace_subdir 必须是无逃逸能力的相对路径（落盘基点，拒绝对路径与 .. 段）
function isSafeSubdir(value: string): boolean {
  if (value.trim().length === 0 || path.isAbsolute(value)) {
    return false;
  }
  return value
    .split(/[\\/]/)
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

let workspaceSubdir = "input";
if (inputRecord.workspace_subdir !== undefined) {
  if (
    typeof inputRecord.workspace_subdir !== "string" ||
    !isSafeSubdir(inputRecord.workspace_subdir)
  ) {
    sdk.fail(
      "input 非法：workspace_subdir 必须是非空的安全相对路径（不含 .. 段、非绝对路径）",
    );
  }
  workspaceSubdir = inputRecord.workspace_subdir;
}

const missingKeys = ["jira_url", "username", "password"].filter(
  (key) => typeof config[key] !== "string" || config[key].length === 0,
);
if (missingKeys.length > 0) {
  sdk.fail(`config 非法：缺 ${missingKeys.join("、")}`);
}

/** 解析 MB 限额配置（config 值均为字符串）；非法 → sdk.fail 指名 */
function parseLimitMb(key: string, fallbackBytes: number): number {
  const raw = config[key];
  if (raw === undefined || raw === "") {
    return fallbackBytes;
  }
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) {
    sdk.fail(
      `config 非法：${key} 必须是正数（MB），当前值 ${JSON.stringify(raw)}`,
    );
  }
  return Math.floor(mb * 1024 * 1024);
}

const maxFileBytes = parseLimitMb("max_file_mb", DEFAULT_MAX_FILE_BYTES);
const maxTotalBytes = parseLimitMb("max_total_mb", DEFAULT_MAX_TOTAL_BYTES);

const client = new JiraClient({
  baseUrl: config.jira_url,
  username: config.username,
  password: config.password,
  // 网关 Basic 凭据（可选）：前置网关反代时缺了会被 401 拦在 jira 之外
  ...(typeof config.redirect_username === "string" &&
  config.redirect_username.length > 0
    ? { redirectUsername: config.redirect_username }
    : {}),
  ...(typeof config.redirect_password === "string" &&
  config.redirect_password.length > 0
    ? { redirectPassword: config.redirect_password }
    : {}),
});

const issueResult = await client.getIssue(issueKey);
if (issueResult.status === "error") {
  sdk.return(issueResult);
}
const issue = issueResult.data;

// 先提取原始身份旁路，再脱敏——顺序不能换（identity 不进 data）
const identity = extractIdentity(issue);
const maskedIssue = createIssueMasker()(issue);

const baseDir = path.join(workspace, workspaceSubdir);
const logsDir = path.join(baseDir, "logs");
fs.mkdirSync(logsDir, { recursive: true });
// 脱敏白名单快照落盘（不落原始响应、不落凭据）
fs.writeFileSync(
  path.join(baseDir, "jira-issue.json"),
  `${JSON.stringify(maskedIssue, null, 2)}\n`,
  "utf8",
);

const attachments = Array.isArray(issue.attachments)
  ? (issue.attachments as Record<string, unknown>[])
  : [];

const logs: IngestedLogFile[] = [];
const skipped: SkippedItem[] = [];
let totalBytes = 0;

const readField = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? (record[key] as string) : "";

for (const attachment of attachments) {
  const filename = readField(attachment, "filename");
  if (filename === "") {
    skipped.push({ filename: "", reason: "missing-filename" });
    continue;
  }
  // 白名单筛选（.log/.txt/.zip/.gz/.tar.gz/.tgz/无扩展名）；MIME 只记录不作判据
  if (!isSupportedAttachmentName(filename)) {
    skipped.push({ filename, reason: "unsupported-extension" });
    continue;
  }
  const contentUrl = readField(attachment, "content");
  if (contentUrl === "") {
    skipped.push({ filename, reason: "missing-content-url" });
    continue;
  }

  const downloaded = await client.downloadAttachment(contentUrl);
  if (downloaded.status === "error") {
    skipped.push({
      filename,
      reason: `download-failed:${downloaded.code}`,
    });
    sdk.log("warn", "附件下载失败，跳过", {
      filename,
      code: downloaded.code,
      message: downloaded.message,
    });
    continue;
  }

  // 限额按下载后的实际字节数校验（声明 size 仅供参考）
  const actualBytes = downloaded.data.byteLength;
  if (actualBytes > maxFileBytes) {
    skipped.push({
      filename,
      reason: `file-too-large:${actualBytes}>${maxFileBytes}`,
    });
    continue;
  }
  if (totalBytes + actualBytes > maxTotalBytes) {
    skipped.push({
      filename,
      reason: `aggregate-limit-exceeded:${totalBytes + actualBytes}>${maxTotalBytes}`,
    });
    continue;
  }
  totalBytes += actualBytes;

  let ingested;
  try {
    ingested = ingestAttachment({ logsDir, filename, buffer: downloaded.data });
  } catch (err) {
    skipped.push({
      filename,
      reason: `ingest-failed:${err instanceof Error ? err.message : String(err)}`,
    });
    sdk.log("warn", "附件解包/归一失败，跳过", {
      filename,
      error: err instanceof Error ? err.message : String(err),
    });
    continue;
  }
  skipped.push(...ingested.skipped);
  if (ingested.files.length === 0) {
    // 包内无日志条目（如 zip 里全是图片）：附件记跳过，空日志不是错误
    skipped.push({ filename, reason: "empty-log-package" });
    continue;
  }
  logs.push(...ingested.files);
}

sdk.log("info", "工单与日志拉取完成", {
  issue_key: issueKey,
  attachments: attachments.length,
  logs: logs.length,
  skipped: skipped.map((item) => `${item.filename}(${item.reason})`),
  totalBytes,
});

sdk.return({
  status: "success",
  data: { issue: maskedIssue, logs, skipped },
  identity,
});
