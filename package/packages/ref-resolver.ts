/**
 * SDK 源码 ref 选择（spec §6.5；规则移植 log-bot task-processor.selectRef，语义不变）。
 *
 * 优先级递减：
 * 1. 工单叙述文本（summary + description 等）中显式出现的 branch / tag / commit / remote ref；
 * 2. Jira versions（受影响版本）中唯一无歧义的值，归一化为 SDK_<version> 标签；
 * 3. 已下载日志内的 `core version` 行。
 *
 * 多个候选版本时用日志 core version 消歧；仍歧义 → 失败并列出候选（不猜，由编排 fail）。
 * fixVersions 只是上下文，**绝不参与选 ref**（它通常指向修复目标版本）——
 * 本模块接口根本不接受 fixVersions，纪律由类型钉死。
 */

import { readFileSync } from "node:fs";

/** 选中的 ref 与依据（provenance 写进 task-context.md 与日志） */
export type RefSelection = {
  ref: string;
  /** 中文依据描述（如「Jira 受影响版本：4.19.1」「日志 core version」） */
  source: string;
  /** 日志 core version（检出消歧或作为选中依据时带上，供 task-context.md） */
  coreVersion?: string;
};

export type RefResolveResult =
  | { ok: true; selection: RefSelection }
  | {
      ok: false;
      reason: string;
      /** 歧义候选（原始版本值）；完全无线索时为空数组 */
      candidates: string[];
    };

/** 版本归一化（spec §6.5）：`4.19.1` / `SDK 4.19.1` / `SDK_4.19.1` → `SDK_4.19.1` */
export function normalizeSdkVersion(
  value: unknown,
): { version: string; tag: string; raw: string } | undefined {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(?:SDK[ _-]?)?([0-9]+(?:\.[0-9]+){1,3})$/i);
  if (!match) {
    return undefined;
  }
  return { version: match[1], tag: `SDK_${match[1]}`, raw };
}

/** 叙述文本中显式出现的 branch / tag / commit / remote ref（log-bot findExplicitRef 同款模式序） */
const EXPLICIT_REF_PATTERNS = [
  /(?:分支(?:信息)?|标签|tag|ref|commit)\s*(?:(?:为|是)\s*)?(?::|：|=)?\s*([A-Za-z0-9._/@-]+)/i,
  /\bemclient-linux(?:\s+(?:branch|ref|tag|commit))?\s*[:=]\s*([A-Za-z0-9._/@-]+)/i,
  /\b(?:branch|ref|tag|commit)\s*[:=]\s*([A-Za-z0-9._/@-]+)/i,
  /\b(SDK_[0-9]+(?:\.[0-9]+){1,3}(?:[A-Za-z0-9._-]*)?)\b/,
];

export function findExplicitRef(narrative: string): string | undefined {
  for (const pattern of EXPLICIT_REF_PATTERNS) {
    const match = narrative.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** 日志 core version 行（log-bot findCoreVersion 同款）：按文件序取首个命中 */
const CORE_VERSION_PATTERN = /core\s+version:\s*([0-9]+(?:\.[0-9]+){1,3})/i;

export function findCoreVersion(
  logFiles: string[],
): { version: string; tag: string; filePath: string } | undefined {
  for (const filePath of logFiles) {
    const text = readFileSync(filePath, "utf8");
    const match = text.match(CORE_VERSION_PATTERN);
    if (match) {
      return { version: match[1], tag: `SDK_${match[1]}`, filePath };
    }
  }
  return undefined;
}

/**
 * 选择 SDK 源码 ref。
 * @param narrative 工单叙述文本（summary + description + himBugContent + himRequirementContent + testScope 拼接）
 * @param versions Jira 受影响版本原值数组（fixVersions 绝不传入）
 * @param logFiles 归一化日志文件的绝对路径（按序扫描 core version）
 */
export function resolveRef(args: {
  narrative: string;
  versions: string[];
  logFiles: string[];
}): RefResolveResult {
  const { narrative, versions, logFiles } = args;

  // 1. 叙述显式 ref 优先（分支/tag/commit 直接可用，不再看版本）
  const explicit = findExplicitRef(narrative);
  if (explicit) {
    return {
      ok: true,
      selection: { ref: explicit, source: "工单叙述显式指定" },
    };
  }

  const coreVersion = findCoreVersion(logFiles);

  // 2. Jira 受影响版本：归一化 + 按 tag 去重
  const jiraVersions = [
    ...new Map(
      versions
        .map(normalizeSdkVersion)
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .map((item) => [item.tag, item]),
    ).values(),
  ];

  if (jiraVersions.length === 1) {
    return {
      ok: true,
      selection: {
        ref: jiraVersions[0].tag,
        source: `Jira 受影响版本：${jiraVersions[0].raw}`,
        ...(coreVersion ? { coreVersion: coreVersion.version } : {}),
      },
    };
  }

  if (jiraVersions.length > 1) {
    // 多候选：用日志 core version 消歧；恰一个命中才采纳，否则不猜
    const matched = coreVersion
      ? jiraVersions.filter(
          (candidate) => candidate.version === coreVersion.version,
        )
      : [];
    if (matched.length === 1) {
      return {
        ok: true,
        selection: {
          ref: matched[0].tag,
          source: `Jira 受影响版本经日志 core version 消歧：${matched[0].raw}`,
          coreVersion: coreVersion!.version,
        },
      };
    }
    return {
      ok: false,
      reason: `Jira 受影响版本存在歧义（候选：${jiraVersions
        .map((item) => item.raw)
        .join("、")}），无法用日志 core version 消解`,
      candidates: jiraVersions.map((item) => item.raw),
    };
  }

  // 3. 日志 core version 兜底
  if (coreVersion) {
    return {
      ok: true,
      selection: {
        ref: coreVersion.tag,
        source: "日志 core version",
        coreVersion: coreVersion.version,
      },
    };
  }

  return {
    ok: false,
    reason:
      "无法确定 SDK 源码 ref：工单叙述无显式分支/tag、Jira 无受影响版本、日志无 core version 行",
    candidates: [],
  };
}
