/**
 * 材料化（spec §6.7）：把 conversation.md 与 task-context.md 落进 run workspace。
 *
 * conversation.md 五段顺序（log-bot 契约）：
 * ① issue key + summary；② description；③ himBugContent；
 * ④ himRequirementContent + testScope（存在时）；⑤ versions / fixVersions / status / priority / updated。
 * 输入快照已是工具脱敏产物，本模块原样排版、不再二次脱敏。
 *
 * task-context.md：工单 key、问题时间窗（若叙述中有）、日志文件清单（路径+大小）、
 * 选中 ref 与 provenance、审计 ref（命中登记表条目的 mainline_ref）。
 * 纪律：不内联日志原文进 prompt——模型自行读文件（spec §6.8）。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type MaterializeLogFile = {
  /** 相对 logs 目录的路径（posix 分隔） */
  file: string;
  /** 来源字节数 */
  size: number;
  source_attachment: string;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item !== "",
  );
}

/** 显式时间点（叙述中的「问题时间窗」线索）：取首个命中的原始文本，找不到 → undefined */
const EXPLICIT_TIME_PATTERN =
  /\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]?\d{1,2}:\d{2}(?::\d{2})?/;

export function extractExplicitTimePoint(
  narrative: string,
): string | undefined {
  return narrative.match(EXPLICIT_TIME_PATTERN)?.[0];
}

/** conversation.md 正文（五段顺序；空段跳过，全空叙述带限制说明） */
export function buildConversation(issue: Record<string, unknown>): string {
  const key = readString(issue.key);
  const summary = readString(issue.summary);
  const description = readString(issue.description);
  const himBugContent = readString(issue.himBugContent);
  const himRequirementContent = readString(issue.himRequirementContent);
  const testScope = readString(issue.testScope);

  const sections: [string, string][] = [
    ["Jira issue", `${key}: ${summary || "（无摘要）"}`],
    ["Jira description", description],
    ["Jira HIM bug content", himBugContent],
    ["Jira HIM requirement content", himRequirementContent],
    ["Jira test scope", testScope],
  ];

  const lines = ["# Jira Analysis Context", ""];
  for (const [heading, content] of sections) {
    if (!content) {
      continue;
    }
    lines.push(`## ${heading}`, "", content, "");
  }
  if (!description && !himBugContent && !himRequirementContent) {
    lines.push("- Limitation: Jira issue has no usable problem narrative.", "");
  }

  const versions = readStringArray(issue.versions);
  const fixVersions = readStringArray(issue.fixVersions);
  lines.push(
    "## Jira metadata",
    "",
    `- Affected versions: ${versions.length > 0 ? versions.join(", ") : "not provided"}`,
    `- Fix versions (context only): ${fixVersions.length > 0 ? fixVersions.join(", ") : "not provided"}`,
    `- Status: ${readString(issue.status) || "not provided"}`,
    `- Priority: ${readString(issue.priority) || "not provided"}`,
    `- Updated: ${readString(issue.updated) || "not provided"}`,
    "",
  );
  return lines.join("\n");
}

/** task-context.md 正文（轻量事实文件；不含日志原文、不含分析引导） */
export function buildTaskContext(args: {
  issueKey: string;
  /** 问题时间窗线索（叙述显式时间点原始文本）；无 → undefined 显示「未指定」 */
  timePoint?: string;
  logs: MaterializeLogFile[];
  ref: string;
  refSource: string;
  coreVersion?: string;
  commitSha: string;
  mainlineRef: string;
}): string {
  const lines = [
    "# Task Context",
    "",
    "## 工单",
    `- Issue key: \`${args.issueKey}\``,
    `- 问题时间窗（叙述线索）: ${args.timePoint ?? "未指定"}`,
    "",
    "## 日志文件清单（自行读取，路径相对 input/logs/）",
  ];
  for (const log of args.logs) {
    lines.push(
      `- \`${log.file}\`（${log.size} 字节，来源附件 ${log.source_attachment}）`,
    );
  }
  lines.push(
    "",
    "## 源码检出",
    `- Selected ref: \`${args.ref}\``,
    `- Ref 依据: ${args.refSource}`,
  );
  if (args.coreVersion) {
    lines.push(`- Core version: \`${args.coreVersion}\``);
  }
  lines.push(
    `- Commit sha: \`${args.commitSha}\``,
    `- 审计 ref（主线）: \`${args.mainlineRef}\``,
    "",
  );
  return lines.join("\n");
}

/**
 * 落盘：{workspace}/input/conversation.md + {workspace}/task-context.md。
 * 调用前提：工具已落 {workspace}/input/jira-issue.json 与 {workspace}/input/logs/。
 */
export async function materializeTask(args: {
  workspace: string;
  issue: Record<string, unknown>;
  issueKey: string;
  timePoint?: string;
  logs: MaterializeLogFile[];
  ref: string;
  refSource: string;
  coreVersion?: string;
  commitSha: string;
  mainlineRef: string;
}): Promise<{ conversationPath: string; taskContextPath: string }> {
  const conversationPath = path.join(
    args.workspace,
    "input",
    "conversation.md",
  );
  const taskContextPath = path.join(args.workspace, "task-context.md");
  await mkdir(path.dirname(conversationPath), { recursive: true });
  await writeFile(conversationPath, buildConversation(args.issue), "utf8");
  await writeFile(
    taskContextPath,
    buildTaskContext({
      issueKey: args.issueKey,
      timePoint: args.timePoint,
      logs: args.logs,
      ref: args.ref,
      refSource: args.refSource,
      ...(args.coreVersion ? { coreVersion: args.coreVersion } : {}),
      commitSha: args.commitSha,
      mainlineRef: args.mainlineRef,
    }),
    "utf8",
  );
  return { conversationPath, taskContextPath };
}
