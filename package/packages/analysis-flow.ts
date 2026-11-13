/**
 * SDK 日志分析主编排（spec §6 步骤 1–11 全序）：
 * 输入过滤 → 拉取工单与日志（jira-log-fetch）→ 自持过滤 F1/F2/F3 → 去重 →
 * 无日志分支 → ref 选择 → worktree 准备 → 材料化 → 大模型分析（链式兜底）→
 * mainline 审计（降级不 fail）→ 组装输出 + 写去重记录。
 *
 * sdk 边界全部经 deps 注入（生产 = 真 sdk，测试 = mock）；流程不直接
 * 调 sdk.return/sdk.fail，而是返回 FlowOutcome 由 main 映射。
 * 步骤 9/10 的 agent 由 deps 注入——本阶段单测用假 agent，真 agent 调用 T4 接。
 *
 * 日志纪律（spec §6）：每个关键节点一条 deps.log——过滤原因（含解析出的字段值）、
 * 工单拉取结果（附件选中/跳过清单）、自持过滤命中项（F1/F2/F3 哪个）、去重命中、
 * ref 选择结果与依据、worktree 路径与 commit、大模型原始输出（完整文本，第一现场）、
 * 报告解析结果、审计结论、通知组装结果。
 */

import path from "node:path";
import type { ModelsInfo } from "@asteriskzuo/agent-sdk";
import { AnalysisRecordStore } from "./analysis-records.js";
import {
  parseAuditOutput,
  runMainlineAudit,
  type MainlineAuditResult,
} from "./mainline-audit.js";
import { materializeTask, extractExplicitTimePoint } from "./materialize.js";
import {
  buildAnalysisNotifyMessage,
  type AnalysisIdentity,
} from "./notify-message.js";
import { parseReviewNotice } from "./notify-parse.js";
import {
  lookupPersonTags as defaultLookupPersonTags,
  lookupWeComAccount as defaultLookupWeComAccount,
  type WeComAccount,
} from "./person-mapping.js";
import { parseAnalysisReport, type AnalysisReport } from "./report-parse.js";
import { resolveRef } from "./ref-resolver.js";
import {
  prepareWorktree,
  resolveGitCredentials,
  type GitCredentials,
  type GitRunner,
} from "./worktree.js";

/** jira 终态工单的 statusCategory 值（与审查业务同一 jira 实例语义） */
const TERMINAL_STATUS_CATEGORY = "Complete";
/** F3 过滤标签缺省值（spec §10：config.assignee_tag 缺省 sdk） */
const DEFAULT_ASSIGNEE_TAG = "sdk";
/** 主线审计 ref 缺省值（spec §6.7/§10） */
const DEFAULT_MAINLINE_REF = "msync";
/** 分析 skill 名（须在本业务绑定的 skill 集合内） */
const ANALYSIS_SKILL = "sdk-log-analysis";

/** jira-log-fetch 工具的输出契约（spec §7）：error 双态是业务可判别的正常输出 */
type JiraLogFetchOutput =
  | {
      status: "success";
      data: {
        issue: Record<string, unknown>;
        logs: { file: string; size: number; source_attachment: string }[];
        skipped: { filename: string; reason: string }[];
      };
      identity?: AnalysisIdentity;
    }
  | { status: "error"; code: string; message: string };

/** 编排结果：由 main 映射到 sdk.return / sdk.fail */
export type FlowOutcome =
  { type: "return"; value: unknown } | { type: "fail"; reason: string };

/** sdk 边界 + 可替换的协作件（可选字段缺省用生产实现，测试注入 fake） */
export type AnalysisFlowDeps = {
  run: (
    program: string,
    args: { input: unknown; config?: Record<string, string> },
  ) => Promise<unknown>;
  agent: (call: {
    skills: string[];
    input: unknown;
    mode?: "channel" | "fresh";
    /** 本次调用使用的模型（provider/id）；链式兜底用，缺省 = 业务默认模型 */
    model?: string;
  }) => Promise<unknown>;
  /** 枚举本业务生效大模型配置；未配置返回空枚举（{ default: "", providers: [] }），不抛错 */
  models: () => Promise<ModelsInfo>;
  config: () => Record<string, string>;
  secret: (name: string) => string;
  log: (
    level: "error" | "warn" | "info" | "debug",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  /** run workspace 绝对路径（main 从 sdk.input() 透传） */
  workspace: string;
  /** 业务缓存根目录读口（main 透传 sdk.cacheDir；懒读——输入过滤短路路径不得触碰） */
  cacheDir: () => string;
  /** 缺省 new AnalysisRecordStore()（落点 sdk.dataDir()）；测试传临时目录实例 */
  store?: AnalysisRecordStore;
  lookupPersonTags?: (user: {
    emailAddress?: string;
    name?: string;
  }) => Promise<string[]>;
  lookupWeComAccount?: (user: {
    emailAddress?: string;
    name?: string;
  }) => Promise<WeComAccount | undefined>;
  /** git 执行器（缺省生产 execFile 实现；测试注入 fake） */
  git?: GitRunner;
};

/** 可选 secret：未注入（sdk.secret 抛错）视为未配置，沿用运行机本地 git 凭据（spec §6.6） */
function trySecret(deps: AnalysisFlowDeps, name: string): string | undefined {
  try {
    return deps.secret(name);
  } catch {
    return undefined;
  }
}

function isJiraLogFetchOutput(value: unknown): value is JiraLogFetchOutput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.status === "success") {
    const data = record.data as Record<string, unknown> | undefined;
    return (
      Boolean(data) &&
      typeof data === "object" &&
      Boolean(data!.issue) &&
      typeof data!.issue === "object" &&
      Array.isArray(data!.logs)
    );
  }
  if (record.status === "error") {
    return (
      typeof record.code === "string" && typeof record.message === "string"
    );
  }
  return false;
}

/** 工单叙述文本（ref 选择第一级的扫描面；conversation.md 同源五字段） */
function buildNarrative(issue: Record<string, unknown>): string {
  return [
    issue.summary,
    issue.description,
    issue.himBugContent,
    issue.himRequirementContent,
    issue.testScope,
  ]
    .filter(
      (value): value is string => typeof value === "string" && value !== "",
    )
    .join("\n");
}

/** agent input 拼装（spec §6.8；不内联日志原文，模型自行读文件） */
function buildAnalysisAgentInput(issueKey: string): string {
  return `## 任务
分析 Jira 工单 ${issueKey} 的 SDK 日志，给出根因结论。

## 工作区文件（相对路径，自行读取）
- task-context.md：任务事实（工单、日志清单、源码版本）
- input/conversation.md：工单语境
- input/logs/：原始日志
- source/：对应版本 SDK 源码（只读）

## 输出
按 skill 定义的报告契约输出一个 JSON 对象。`;
}

/** 链式兜底 agent 调用结果：ok 命中采纳（parsed 为各自契约的解析产物） */
type AgentChainOutcome<T> =
  { ok: true; parsed: T } | { ok: false; reason: string };

/**
 * 链式兜底 agent 调用（spec §6.8 pi 适配纪律，同审查业务 runAgentReviewWithFallback 模式）：
 * sdk.models() 枚举生效配置全部 provider/model，按声明顺序逐个 fresh 会话尝试，
 * 首个产出合法结果的模型即采纳；空枚举/枚举失败/全部失败 → ok:false。
 * 分析步骤与审计步骤各自独立兜底（各自调一次本函数）。
 */
async function runAgentChainWithFallback<T>(
  deps: AnalysisFlowDeps,
  args: {
    issueKey: string;
    label: string; // 日志用步骤名（"分析" / "审计"）
    input: unknown;
    parse: (output: string) => T | undefined;
  },
): Promise<AgentChainOutcome<T>> {
  let modelsInfo: ModelsInfo;
  try {
    modelsInfo = await deps.models();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log("error", `枚举大模型配置失败（${args.label}）`, {
      issueKey: args.issueKey,
      errorMessage: message,
    });
    return { ok: false, reason: `枚举大模型配置失败：${message}` };
  }

  const chain = modelsInfo.providers.flatMap((provider) =>
    provider.models.map((model) => `${provider.name}/${model}`),
  );
  if (chain.length === 0) {
    deps.log("error", `业务未配置大模型配置（${args.label}）`, {
      issueKey: args.issueKey,
    });
    return { ok: false, reason: "业务未配置大模型配置" };
  }

  const failures: string[] = [];
  for (const model of chain) {
    let outputText: string;
    try {
      const output = await deps.agent({
        skills: [ANALYSIS_SKILL],
        input: args.input,
        // 单轮分析无状态语义：每次尝试独立会话
        mode: "fresh",
        model,
      });
      outputText = typeof output === "string" ? output : JSON.stringify(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log("warn", `模型调用失败，尝试下一个（${args.label}）`, {
        issueKey: args.issueKey,
        model,
        errorMessage: message,
      });
      failures.push(`${model}: 调用失败 ${message}`);
      continue;
    }

    // 原始输出先落日志再解析：解析失败时第一现场已在业务日志里
    deps.log("info", `大模型原始输出（${args.label}）`, {
      issueKey: args.issueKey,
      model,
      output: outputText,
    });
    const parsed = args.parse(outputText);
    if (parsed) {
      return { ok: true, parsed };
    }
    deps.log("warn", `模型输出解析失败，尝试下一个（${args.label}）`, {
      issueKey: args.issueKey,
      model,
    });
    failures.push(`${model}: 输出解析失败`);
  }

  deps.log("error", `全部模型${args.label}失败`, {
    issueKey: args.issueKey,
    attempts: failures.length,
  });
  return {
    ok: false,
    reason: `全部模型${args.label}失败：${failures.join("；")}`,
  };
}

/**
 * 执行一轮日志分析。event 为入口事件信封（派生事件，payload = 审查输出
 * {content, mentions} 或 null）。
 */
export async function runAnalysisFlow(
  event: unknown,
  deps: AnalysisFlowDeps,
): Promise<FlowOutcome> {
  const payload =
    event && typeof event === "object"
      ? (event as { payload?: unknown }).payload
      : undefined;
  const config = deps.config();
  const lookupPersonTags = deps.lookupPersonTags ?? defaultLookupPersonTags;
  const lookupWeComAccount =
    deps.lookupWeComAccount ?? defaultLookupWeComAccount;

  // 1. 输入过滤（§3.4 + §4.2）：认不出/不该做就不做——return(null) 不是失败
  const parsed = parseReviewNotice(payload);
  if (!parsed.ok) {
    if (parsed.skipReason === "issue_key_not_found") {
      deps.log("warn", "审查通知解析失败：未找到工单 key，跳过分析", {});
    } else {
      deps.log("info", "输入过滤：跳过分析", { skipReason: parsed.skipReason });
    }
    return { type: "return", value: null };
  }
  const issueKey = parsed.issueKey;
  deps.log("info", "审查通知解析通过", { issueKey });

  // 去重记录存储（步骤 3 起用；懒构造——payload 过滤路径不触碰 dataDir）
  const store = deps.store ?? new AnalysisRecordStore();

  // 2. 拉取工单与日志（工具落盘 input/logs/ + input/jira-issue.json 于 run workspace）
  const jiraUrl = config.jira_url ?? "";
  const fetched = await deps.run("jira-log-fetch", {
    input: { issue_key: issueKey, workspace_subdir: "input" },
    config: {
      jira_url: jiraUrl,
      username: deps.secret("jira_username"),
      password: deps.secret("jira_password"),
      // 网关 Basic 凭据：easemob jira 前置网关要求，缺了会被网关 401 拦截
      redirect_username: deps.secret("jira_redirect_username"),
      redirect_password: deps.secret("jira_redirect_password"),
    },
  });
  if (!isJiraLogFetchOutput(fetched)) {
    deps.log("error", "拉取工单失败：jira-log-fetch 返回非法结果", {
      issueKey,
    });
    return {
      type: "fail",
      reason: `拉取工单 ${issueKey} 失败：jira-log-fetch 返回非法结果`,
    };
  }
  if (fetched.status === "error") {
    deps.log("error", "拉取工单失败", {
      issueKey,
      code: fetched.code,
      errorMessage: fetched.message,
    });
    return {
      type: "fail",
      reason: `拉取工单 ${issueKey} 失败：${fetched.code} ${fetched.message}`,
    };
  }
  const issue = fetched.data.issue;
  const logs = fetched.data.logs;
  const identity = fetched.identity;
  const liveUpdated =
    typeof issue.updated === "string" && issue.updated !== ""
      ? issue.updated
      : undefined;
  deps.log("info", "工单与日志拉取成功", {
    issueKey,
    logs: logs.map((item) => item.file),
    skipped: fetched.data.skipped.map(
      (item) => `${item.filename}(${item.reason})`,
    ),
    updated: liveUpdated,
  });

  // 3. 自持过滤（§4.3；F1/F2/F3 命中 → 写去重记录 + info 日志 + return(null)）
  if (issue.statusCategory === TERMINAL_STATUS_CATEGORY) {
    await store.markAnalyzed(issueKey, liveUpdated);
    deps.log("info", "F1 终态工单，跳过分析", {
      issueKey,
      status: issue.status,
    });
    return { type: "return", value: null };
  }

  const issueType =
    typeof issue.issueType === "string" ? issue.issueType : undefined;
  if (issueType === undefined) {
    deps.log("warn", "工单缺 issueType 字段，继续分析", { issueKey });
  } else if (issueType !== "Bug") {
    await store.markAnalyzed(issueKey, liveUpdated);
    deps.log("info", "F2 非 Bug 工单，跳过分析", { issueKey, issueType });
    return { type: "return", value: null };
  }

  // F3：负责人无 sdk 标签不分析（v2 CATEGORY_SUBSCRIPTION_TAG 平移）；
  // identity 无 assignee / 映射查不到记录 → 视为无标签跳过（v2 同款语义）
  const assigneeTag = config.assignee_tag ?? DEFAULT_ASSIGNEE_TAG;
  const hasAssignee = Boolean(
    identity?.assigneeEmail || identity?.assigneeName,
  );
  const tags = hasAssignee
    ? await lookupPersonTags({
        emailAddress: identity?.assigneeEmail,
        name: identity?.assigneeName,
      })
    : [];
  deps.log("info", "负责人标签查询完成", { issueKey, assigneeTag, tags });
  if (!tags.includes(assigneeTag)) {
    await store.markAnalyzed(issueKey, liveUpdated);
    deps.log("info", "F3 负责人无订阅标签，跳过分析", {
      issueKey,
      assigneeTag,
      hasAssignee,
      tags,
    });
    return { type: "return", value: null };
  }

  // 4. 去重：实时 updated 与记录相同 → 跳过；updated 缺失 → 不去重 + warn
  if (!liveUpdated) {
    deps.log("warn", "实时工单缺 updated，本次不去重（每次都分析）", {
      issueKey,
    });
  } else if (await store.shouldSkip(issueKey, liveUpdated)) {
    deps.log("info", "去重命中：updated 未变，跳过分析", {
      issueKey,
      updated: liveUpdated,
    });
    return { type: "return", value: null };
  }

  // 5. 无日志分支（决策点 D2）：写去重记录 + info 日志 + return(null)，不通知不失败
  if (logs.length === 0) {
    await store.markAnalyzed(issueKey, liveUpdated);
    deps.log("info", "无日志附件，跳过分析", { issueKey, reason: "no_logs" });
    return { type: "return", value: null };
  }

  // 6. SDK 源码 ref 选择（§6.5）：歧义无法消解 → fail（消息带候选列表，可行动失败）
  const narrative = buildNarrative(issue);
  const logFiles = logs.map((item) =>
    path.join(deps.workspace, "input", "logs", item.file),
  );
  const versions = Array.isArray(issue.versions)
    ? issue.versions.filter(
        (item): item is string => typeof item === "string" && item !== "",
      )
    : [];
  const refResult = resolveRef({ narrative, versions, logFiles });
  if (!refResult.ok) {
    deps.log("error", "ref 选择失败", {
      issueKey,
      reason: refResult.reason,
      candidates: refResult.candidates,
    });
    return {
      type: "fail",
      reason: `工单 ${issueKey} ref 选择失败：${refResult.reason}`,
    };
  }
  const selection = refResult.selection;
  deps.log("info", "ref 选择完成", {
    issueKey,
    ref: selection.ref,
    source: selection.source,
    coreVersion: selection.coreVersion,
  });

  // 7. worktree 准备（§6.6：远端 URL + bare 缓存）：ref 解析/检出失败 → 回退主线重试（§6.5）
  const sdkRepoUrl = config.sdk_repo_url ?? "";
  if (!/^https?:\/\//.test(sdkRepoUrl)) {
    deps.log(
      "error",
      "config.sdk_repo_url 缺失或非 http(s) URL，无法准备源码 worktree",
      {
        issueKey,
      },
    );
    return {
      type: "fail",
      reason: `工单 ${issueKey} 分析失败：config.sdk_repo_url 缺失或不是 http(s) URL（控制台登记该仓远端地址，如 https://github.com/easemob/emclient-linux）`,
    };
  }
  // 凭据纪律（§6.6/D11，key 按账号）：config.sdk_repo_account 是账号名；有账号名则
  // 宽容读 git_account_{账号}_username/token 一对 secrets——两个都拿到才注入凭据，
  // 缺一个记 warn 按无凭据继续（公开仓场景；不做「公开仓 = 无账号」限制）
  const repoAccount = config.sdk_repo_account;
  let gitCredentials: GitCredentials | undefined;
  if (repoAccount) {
    const username = trySecret(deps, `git_account_${repoAccount}_username`);
    const token = trySecret(deps, `git_account_${repoAccount}_token`);
    gitCredentials = resolveGitCredentials({
      account: repoAccount,
      username,
      token,
    });
    if (!gitCredentials) {
      deps.log("warn", "git 账号凭据不完整，按无凭据继续（公开仓场景）", {
        issueKey,
        account: repoAccount,
        hasUsername: Boolean(username),
        hasToken: Boolean(token),
      });
    }
  }
  // 解析失败回退主线（§6.5，log-bot ref-resolver.js fallbackRef + repository-set.js
  // preparer 同款语义）：选中 ref 阶梯最终失败（含网络 fetch 失败）且选中的不是
  // 主线本身 → 回退 mainline_ref 重试一次，provenance 记回退说明、置信度 branch-head；
  // 选中的本来就是主线不自我重复，连主线也失败才 fail
  const mainlineRef = config.mainline_ref ?? DEFAULT_MAINLINE_REF;
  const prepareSource = (ref: string) =>
    prepareWorktree({
      repoUrl: sdkRepoUrl,
      cacheDir: deps.cacheDir(),
      workspace: deps.workspace,
      ref,
      sourceSubdir: "source",
      ...(gitCredentials ? { credentials: gitCredentials } : {}),
      ...(deps.git ? { git: deps.git } : {}),
    });
  let worktree: Awaited<ReturnType<typeof prepareWorktree>>;
  let effectiveRef = selection.ref;
  let refSource = selection.source;
  try {
    worktree = await prepareSource(selection.ref);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (selection.ref === mainlineRef) {
      deps.log("error", "worktree 准备失败", {
        issueKey,
        ref: selection.ref,
        errorMessage: message,
      });
      return {
        type: "fail",
        reason: `工单 ${issueKey} worktree 准备失败（ref=${selection.ref}）：${message}`,
      };
    }
    deps.log("warn", "选中 ref 解析失败，回退主线重试", {
      issueKey,
      ref: selection.ref,
      mainlineRef,
      errorMessage: message,
    });
    try {
      worktree = await prepareSource(mainlineRef);
      effectiveRef = mainlineRef;
      refSource = `${selection.source}；ref '${selection.ref}' 未命中，回退主线 ${mainlineRef}（置信度 branch-head）`;
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      deps.log("error", "worktree 准备失败（回退主线仍失败）", {
        issueKey,
        ref: selection.ref,
        mainlineRef,
        errorMessage: fallbackMessage,
      });
      return {
        type: "fail",
        reason: `工单 ${issueKey} worktree 准备失败（ref=${selection.ref}，回退主线 ${mainlineRef} 仍失败）：${fallbackMessage}`,
      };
    }
  }
  deps.log("info", "worktree 准备完成", {
    issueKey,
    sourceDir: worktree.sourceDir,
    commitSha: worktree.commitSha,
    reused: worktree.reused,
    fetched: worktree.fetched,
  });

  // 8. 材料化（§6.7）：conversation.md + task-context.md 落 run workspace
  await materializeTask({
    workspace: deps.workspace,
    issue,
    issueKey,
    timePoint: extractExplicitTimePoint(narrative),
    logs,
    ref: effectiveRef,
    refSource,
    ...(selection.coreVersion ? { coreVersion: selection.coreVersion } : {}),
    commitSha: worktree.commitSha,
    mainlineRef,
  });
  deps.log("info", "材料化完成", { issueKey });

  // 9. 大模型分析（§6.8，链式兜底；输出解析失败 → fail）
  const analyzed = await runAgentChainWithFallback(deps, {
    issueKey,
    label: "分析",
    input: buildAnalysisAgentInput(issueKey),
    parse: parseAnalysisReport,
  });
  if (!analyzed.ok) {
    return {
      type: "fail",
      reason: `分析报告解析失败：${analyzed.reason}`,
    };
  }
  const report: AnalysisReport = analyzed.parsed;
  deps.log("info", "分析报告解析成功", {
    issueKey,
    confidence: report.confidence,
    rootCause: report.root_cause,
  });

  // 10. mainline 审计（§6.9）：任何异常降级 unknown 继续，不 fail run
  const audit: MainlineAuditResult = await runMainlineAudit({
    workspace: deps.workspace,
    sdkRepoUrl,
    cacheDir: deps.cacheDir(),
    mainlineRef,
    issueKey,
    report,
    agentCall: async (input) => {
      const audited = await runAgentChainWithFallback(deps, {
        issueKey,
        label: "审计",
        input,
        // 审计契约的合法解析即采纳（unknown 也是合法结论）
        parse: (output) => parseAuditOutput(output),
      });
      if (!audited.ok) {
        throw new Error(audited.reason);
      }
      return JSON.stringify(audited.parsed);
    },
    ...(gitCredentials ? { credentials: gitCredentials } : {}),
    ...(deps.git ? { git: deps.git } : {}),
    log: deps.log,
  });
  deps.log("info", "mainline 审计结论", {
    issueKey,
    status: audit.status,
    fixCommit: audit.fix_commit,
  });

  // 11. 组装输出（§6.10）→ 写去重记录 → return
  const url = `${jiraUrl.replace(/\/+$/, "")}/browse/${issueKey}`;
  const message = await buildAnalysisNotifyMessage(
    { issueKey, url, report, audit, identity },
    lookupWeComAccount,
  );
  await store.markAnalyzed(issueKey, liveUpdated);
  deps.log("info", "通知组装完成", {
    issueKey,
    mentions: message.mentions ?? [],
    mainlineStatus: audit.status,
    confidence: report.confidence,
  });
  return {
    type: "return",
    value: {
      ...message,
      issue_key: issueKey,
      url,
      root_cause: report.root_cause,
      confidence: report.confidence,
      mainline_status: audit.status,
      summary: report.summary,
      metrics: {
        mainline_status: audit.status,
        confidence: report.confidence,
      },
    },
  };
}
