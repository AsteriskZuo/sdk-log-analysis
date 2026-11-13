/**
 * mainline 审计（spec §6.9）：回答「这个问题在主线（默认 msync）上是否已修复」。
 *
 * 流程：准备第二个 worktree（{workspace}/mainline-audit/source 检出 mainline_ref）
 * → 第二次 agent（fresh，prompt 含分析报告 + 工单语境 + 审计 worktree 只读路径）
 * → 解析审计契约 JSON → **git 验证兜底**：already-fixed 且带 fix_commit 时，代码验证
 * 该 SHA 是审计 worktree HEAD 的祖先（merge-base --is-ancestor）并用 git show 的规范
 * 元数据替换模型自述；验证不过 → 降级 unknown。**绝不发布未经验证的 SHA**。
 *
 * 降级语义：本阶段任何异常（worktree 失败 / agent 失败 / 输出非法）→ warn 日志 +
 * status 'unknown' 继续——**审计降级不拖垮主分析**（本函数永不抛错）。
 * agent 由编排注入（本阶段假 agent，真 agent 调用 T4 接）。
 */

import path from "node:path";
import {
  defaultGitRunner,
  gitIsAncestor,
  gitShowMetadata,
  gitVerifySha,
  prepareWorktree,
  type GitCredentials,
  type GitRunner,
} from "./worktree.js";
import type { AnalysisReport } from "./report-parse.js";

export type MainlineAuditStatus = "already-fixed" | "not-fixed" | "unknown";

export type MainlineAuditResult = {
  status: MainlineAuditStatus;
  summary: string;
  /** git show 规范化后的完整 sha；仅 already-fixed 且 git 验证通过时携带 */
  fix_commit?: string;
};

/** 审计 agent 调用（编排注入：模型兜底链后返回首个可解析文本；全部失败则抛错） */
export type AuditAgentCall = (input: string) => Promise<string>;

type LogFn = (
  level: "error" | "warn" | "info" | "debug",
  message: string,
  fields?: Record<string, unknown>,
) => void;

const AUDIT_STATUSES: readonly MainlineAuditStatus[] = [
  "already-fixed",
  "not-fixed",
  "unknown",
];

/** 审计输出契约解析（直接 parse → markdown 围栏；status 值域 + summary 必填校验） */
export function parseAuditOutput(
  output: string,
):
  | { status: MainlineAuditStatus; summary: string; fix_commit?: string }
  | undefined {
  const candidates = [output.trim()];
  const fenceMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    candidates.push(fenceMatch[1].trim());
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const status =
        typeof parsed.status === "string" &&
        (AUDIT_STATUSES as readonly string[]).includes(parsed.status)
          ? (parsed.status as MainlineAuditStatus)
          : undefined;
      const summary =
        typeof parsed.summary === "string" && parsed.summary.trim() !== ""
          ? parsed.summary.trim()
          : undefined;
      if (!status || !summary) {
        continue;
      }
      const fixCommit =
        typeof parsed.fix_commit === "string" && parsed.fix_commit.trim() !== ""
          ? parsed.fix_commit.trim()
          : undefined;
      return {
        status,
        summary,
        ...(fixCommit ? { fix_commit: fixCommit } : {}),
      };
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined;
}

/** 审计 prompt（文本）：报告 + 工单语境 + 审计 worktree 相对路径（只读纪律写死） */
export function buildAuditPrompt(args: {
  issueKey: string;
  mainlineRef: string;
  report: AnalysisReport;
}): string {
  return `## 任务：主线修复审计（只读）
判断 Jira 工单 ${args.issueKey} 对应的问题在主线 ${args.mainlineRef} 上是否已修复。

## 工作区文件（相对路径，自行读取）
- task-context.md：任务事实（工单、日志清单、源码版本）
- input/conversation.md：工单语境
- input/logs/：原始日志
- mainline-audit/source/：主线 ${args.mainlineRef} 源码（只读，不得修改任何文件）

## 原分析报告
\`\`\`json
${JSON.stringify(args.report, null, 2)}
\`\`\`

## 只读约束
- 不得修改任何源码或任务文件；不得创建分支、commit、push。
- 必须用源码内容核对，不能仅凭 commit message 推断已修复；证据不足时状态必须为 unknown。

## 输出
按 skill 定义的审计契约输出一个 JSON 对象：
{"status":"already-fixed"|"not-fixed"|"unknown","summary":"中文证据摘要","fix_commit":"<可选：最能证明修复的 commit sha>"}
already-fixed 必须给出 fix_commit；调用方会用 git 验证该 SHA，验证不过将降级 unknown。`;
}

function unknownResult(summary: string): MainlineAuditResult {
  return { status: "unknown", summary };
}

/**
 * 执行主线审计；任何异常降级 unknown（warn 留痕），永不抛错。
 */
export async function runMainlineAudit(args: {
  workspace: string;
  /** 命中登记表条目的 url（编排注入；bare 缓存仓的唯一 origin） */
  sdkRepoUrl: string;
  /** 业务缓存根目录（编排注入 sdk.cacheDir()；bare 仓定位 {cacheDir}/repos/{slug}） */
  cacheDir: string;
  /** 命中登记表条目的 mainline_ref（编排注入，无 env 缺省值路径） */
  mainlineRef: string;
  issueKey: string;
  report: AnalysisReport;
  agentCall: AuditAgentCall;
  /** 可选私有仓凭据（同 worktree 纪律：缺一视为未配置，按匿名继续） */
  credentials?: GitCredentials;
  git?: GitRunner;
  log: LogFn;
}): Promise<MainlineAuditResult> {
  const git = args.git ?? defaultGitRunner;
  const { log } = args;

  // 1. 准备审计 worktree（{workspace}/mainline-audit/source）
  let sourceDir: string;
  let headSha: string;
  try {
    const worktree = await prepareWorktree({
      repoUrl: args.sdkRepoUrl,
      cacheDir: args.cacheDir,
      workspace: path.join(args.workspace, "mainline-audit"),
      ref: args.mainlineRef,
      sourceSubdir: "source",
      ...(args.credentials ? { credentials: args.credentials } : {}),
      git,
    });
    sourceDir = worktree.sourceDir;
    headSha = worktree.commitSha;
  } catch (error) {
    log("warn", "mainline 审计 worktree 准备失败，降级 unknown", {
      issueKey: args.issueKey,
      mainlineRef: args.mainlineRef,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return unknownResult("主线审计未能准备源码检出（worktree 失败）");
  }

  // 2. 第二次 agent（fresh 由编排保证）；失败/输出非法 → 降级
  let parsed: ReturnType<typeof parseAuditOutput>;
  try {
    const output = await args.agentCall(
      buildAuditPrompt({
        issueKey: args.issueKey,
        mainlineRef: args.mainlineRef,
        report: args.report,
      }),
    );
    parsed = parseAuditOutput(output);
    if (!parsed) {
      log("warn", "mainline 审计输出解析失败，降级 unknown", {
        issueKey: args.issueKey,
      });
      return unknownResult("主线审计输出无法解析");
    }
  } catch (error) {
    log("warn", "mainline 审计 agent 调用失败，降级 unknown", {
      issueKey: args.issueKey,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return unknownResult("主线审计模型调用失败");
  }

  // 3. not-fixed / unknown：无 fix_commit 验证义务，原样采纳（fix_commit 丢弃）
  if (parsed.status !== "already-fixed") {
    return { status: parsed.status, summary: parsed.summary };
  }

  // 4. already-fixed：fix_commit 必须过 git 验证——绝不发布未经验证的 SHA
  if (!parsed.fix_commit) {
    log("warn", "mainline 审计声称已修复但未给 fix_commit，降级 unknown", {
      issueKey: args.issueKey,
    });
    return unknownResult("主线审计声称已修复但未提供修复 commit");
  }
  try {
    const canonicalSha = await gitVerifySha(git, sourceDir, parsed.fix_commit);
    const isAncestor =
      canonicalSha !== undefined &&
      (await gitIsAncestor(git, sourceDir, canonicalSha, headSha));
    if (!canonicalSha || !isAncestor) {
      log("warn", "mainline 审计 fix_commit 未通过祖先校验，降级 unknown", {
        issueKey: args.issueKey,
        fixCommit: parsed.fix_commit,
      });
      return unknownResult("主线审计声称已修复，但修复 commit 未通过 git 校验");
    }
    // git show 规范元数据替换模型自述（字段缺一 → 降级）
    const metadata = await gitShowMetadata(git, sourceDir, canonicalSha);
    if (!metadata) {
      log("warn", "mainline 审计 fix_commit 元数据读取失败，降级 unknown", {
        issueKey: args.issueKey,
        fixCommit: canonicalSha,
      });
      return unknownResult("主线审计修复 commit 元数据校验失败");
    }
    return {
      status: "already-fixed",
      summary: parsed.summary,
      fix_commit: metadata.sha,
    };
  } catch (error) {
    log("warn", "mainline 审计 git 验证异常，降级 unknown", {
      issueKey: args.issueKey,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return unknownResult("主线审计 git 验证异常");
  }
}
