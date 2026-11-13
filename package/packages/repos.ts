/**
 * 仓库登记表加载与校验（多仓登记表 spec §4.1，决策 D1/D4/D6/D10/D11）。
 *
 * 登记表（包根 repos.json，与 agent-package.json 同级）是仓库组的唯一权威来源：
 * url / mainline_ref / assignee_tag / account / match / notes 全部随业务包版本管理，
 * 平台 env 不再承载 sdk_repo_url / mainline_ref / assignee_tag / sdk_repo_account。
 *
 * 加载纪律（spec §4.1）：
 * - 加载口统一为 loadRepoRegistry()；以包根为锚点解析（import.meta.url 相对定位，
 *   不依赖 cwd、不读 env）——编译产物在 dist/packages/，上溯两级即包根
 *   （物化产物与本地 dev 的 dist-test 布局一致，同 person-mapping 的映射表定位）。
 * - 读取 + JSON 解析 + 逐字段校验，任何非法 → 抛错（入口映射 sdk.fail）；
 *   错误信息必须指明哪个条目、哪个字段、为什么。
 * - 登记表文件缺失 → fail（它是业务运行的必要输入）。
 * - 不做缓存：三个入口（main / check-input / warmup）各自调用，每次 run 读一次是
 *   廉价路径，避免缓存失效问题。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 登记表 schema 版本（spec §4.1：当前恒 1；更大版本 fail 提示升级，更小版本按 1 处理） */
export const REPO_REGISTRY_VERSION = 1;

/**
 * 登记表单条仓条目（spec §4.1 逐字段语义，每个成员都是契约）。
 * 加载时已归一化：match 关键词 trim + 小写（调用方可直接做小写子串匹配）。
 */
export type RepoEntry = {
  /** 仓的稳定短标识（小写字母/数字/连字符），全表唯一；用于日志、通知、metrics 标注 */
  key: string;
  /** 仓远端地址（必须 http(s)）；bare 缓存的唯一 origin，slug 由 url 派生 */
  url: string;
  /** 该仓主线分支/标签，主线审计（mainline-audit）检出用 */
  mainline_ref: string;
  /** 该仓的通知对象标签（F3 过滤与 @人 用） */
  assignee_tag: string;
  /**
   * 账号名引用（可选）：有值则凭据按 git_account_{account}_username/token 解析
   * （宽容读，缺 key 按无凭据继续）；缺省 = 公开仓匿名
   */
  account?: string;
  /** 选仓关键词（非空，元素非空；加载时已 trim + 小写归一），见 repo-select.ts */
  match: string[];
  /** 该仓背景知识（可选）：选仓命中后注入分析提示词；缺省不注入 */
  notes?: string;
};

/** 登记表整体（数组顺序即选仓优先级，决策 D8：越具体的仓越靠前） */
export type RepoRegistry = {
  /** schema 版本（当前恒 1） */
  version: number;
  /** 仓条目列表，key 全表唯一，非空 */
  repos: RepoEntry[];
};

/**
 * 默认登记表落点：包根 repos.json（与 agent-package.json 同级）。
 * 本模块编译产物在 dist/packages/（dist/packages/repos.js），上溯两级即包根；
 * 物化产物与本地 dev（dist-test 布局一致）相对位置相同。
 */
function defaultRegistryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "repos.json");
}

/** key 合法形状（spec §4.1：小写字母/数字/连字符） */
const KEY_PATTERN = /^[a-z0-9-]+$/;

/** 校验失败统一抛错（message 指明条目、字段、原因，供入口映射 sdk.fail） */
function fail(message: string): never {
  throw new Error(`仓库登记表非法：${message}`);
}

/**
 * 校验并归一化单条仓条目。
 * @param raw 原始 JSON 值（未信）
 * @param index 数组下标（错误定位用）
 */
function validateEntry(raw: unknown, index: number): RepoEntry {
  const at = `repos[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${at} 必须是对象`);
  }
  const record = raw as Record<string, unknown>;

  // 定位优先用 key，其次 url，便于在错误信息里指认条目
  const label =
    typeof record.key === "string" && record.key !== ""
      ? `${at}（key=${record.key}）`
      : at;

  if (typeof record.key !== "string" || record.key === "") {
    fail(`${at} 缺少必填字段 key（仓稳定短标识）`);
  }
  if (!KEY_PATTERN.test(record.key)) {
    fail(
      `${label} 的 key 非法：只允许小写字母/数字/连字符，当前为 "${record.key}"`,
    );
  }

  if (typeof record.url !== "string" || record.url === "") {
    fail(`${label} 缺少必填字段 url（仓远端地址）`);
  }
  if (!/^https?:\/\//.test(record.url)) {
    fail(`${label} 的 url 必须是 http(s) 地址，当前为 "${record.url}"`);
  }

  if (typeof record.mainline_ref !== "string" || record.mainline_ref === "") {
    fail(`${label} 缺少必填字段 mainline_ref（主线分支/标签）`);
  }

  if (typeof record.assignee_tag !== "string" || record.assignee_tag === "") {
    fail(`${label} 缺少必填字段 assignee_tag（通知对象标签）`);
  }

  if (
    record.account !== undefined &&
    (typeof record.account !== "string" || record.account === "")
  ) {
    fail(`${label} 的 account 若提供必须是非空字符串（账号名引用）`);
  }

  if (!Array.isArray(record.match) || record.match.length === 0) {
    fail(`${label} 缺少必填字段 match（选仓关键词，非空数组）`);
  }
  const match = record.match.map((keyword, keywordIndex) => {
    if (typeof keyword !== "string" || keyword.trim() === "") {
      fail(`${label} 的 match[${keywordIndex}] 必须是非空字符串（选仓关键词）`);
    }
    // 小写归一（spec §4.1）：选仓按小写子串匹配，加载时统一归位
    return keyword.trim().toLowerCase();
  });

  if (record.notes !== undefined && typeof record.notes !== "string") {
    fail(`${label} 的 notes 若提供必须是字符串（该仓背景知识）`);
  }

  return {
    key: record.key,
    url: record.url,
    mainline_ref: record.mainline_ref,
    assignee_tag: record.assignee_tag,
    ...(record.account !== undefined ? { account: record.account } : {}),
    match,
    ...(record.notes !== undefined ? { notes: record.notes } : {}),
  };
}

/**
 * 加载并校验仓库登记表。
 *
 * @param registryPath 登记表文件路径；缺省 = 包根 repos.json（import.meta.url 锚定，
 *   不依赖 cwd）。测试传 fixture 路径；生产入口一律缺省调用。
 * @returns 校验通过且已归一化（match 小写）的登记表；数组顺序保持文件原序（即选仓优先级）。
 * @throws 文件缺失 / JSON 解析失败 / 任何字段非法（message 指明条目、字段、原因）。
 */
export function loadRepoRegistry(registryPath?: string): RepoRegistry {
  const filePath = registryPath ?? defaultRegistryPath();

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `仓库登记表读取失败：${filePath}（登记表是业务运行的必要输入，与 agent-package.json 同级必要）：${message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`仓库登记表 JSON 解析失败：${filePath}：${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("根节点必须是对象（{ version, repos }）");
  }
  const root = parsed as Record<string, unknown>;

  // version（spec §4.1）：必填 number；更大版本 fail 提示升级，更小版本按 1 处理
  if (typeof root.version !== "number" || Number.isNaN(root.version)) {
    fail("缺少必填字段 version（schema 版本，number，当前恒 1）");
  }
  if (root.version > REPO_REGISTRY_VERSION) {
    fail(
      `version=${root.version} 高于当前支持的 ${REPO_REGISTRY_VERSION}，请升级业务包`,
    );
  }

  if (!Array.isArray(root.repos) || root.repos.length === 0) {
    fail("缺少必填字段 repos（仓条目列表，非空数组）");
  }

  const repos = root.repos.map(validateEntry);

  // key 全表唯一
  const seen = new Set<string>();
  for (const entry of repos) {
    if (seen.has(entry.key)) {
      fail(`key "${entry.key}" 重复登记（key 必须全表唯一）`);
    }
    seen.add(entry.key);
  }

  return { version: REPO_REGISTRY_VERSION, repos };
}
