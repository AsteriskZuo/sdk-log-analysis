/**
 * 仓预热（多仓登记表 spec docs/specs/2026-11-13-sdk-repo-registry-spec.md §4.3 warmup 节）：
 * 平台定时任务规则触发的无事件 run（main-only 阶段），把慢操作（克隆/fetch）挪到
 * 闲时，保持 {cacheDir}/repos/{slug} 的 bare 缓存新鲜，事件 run 的 prepareWorktree
 * 因此命中热仓（worktree add ~1.5s）。
 *
 * 多仓改造（T4）：从「单仓预热」改为「遍历登记表逐仓预热」。
 * - 仓清单唯一权威来源 = 包根 repos.json 登记表（决策 D1），加载统一走
 *   repos.ts 的 loadRepoRegistry（全字段校验）；不再读 vars 的
 *   sdk_repo_url / sdk_repo_account（两 key 随本 spec 落地从控制台删除）。
 * - 预热范围维持全分支语义（决策 D9）：bare clone + git fetch --no-tags origin
 *   本来就同步所有分支；不做 top-3 热点分支选择。
 * - 单仓失败不阻断（spec §4.3）：每仓独立 try/catch，失败记 warn（含 key 与脱敏
 *   错误摘要）并继续下一仓——预热是尽力而为，单仓故障不应拖垮全部仓的新鲜度。
 *   仅登记表加载失败（必要输入缺失）整体失败，由入口映射 sdk.fail。
 *
 * 与运行时共用同一把锁与同一份协议：锁/定位/凭据组装全部 import worktree.ts
 * 已导出件（repoCacheDir/withRepoLock/resolveGitCredentials），不改其任何签名。
 * 锁内动作：无缓存 → 首克隆（{目标}.tmp-{pid} 临时目录 + renameSync 转正，防半成品）；
 * 有缓存 → git fetch --no-tags origin。随后机会性 worktree prune（失败忽略）。
 *
 * 凭据纪律与主流程序完全一致：登记表条目 account（账号名）+ 安全桶
 * git_account_{账号}_username/token 一对，宽容读（缺 key 按无凭据继续，公开仓
 * 场景；绝不强制读 secrets）。凭据只以 http.extraHeader 挂命令行，绝不进日志/
 * 错误信息（错误摘要经脱敏）。
 */

import { existsSync, renameSync, rmSync } from "node:fs";
import { type RepoEntry } from "./repos.js";
import {
  defaultGitRunner,
  repoCacheDir,
  resolveGitCredentials,
  withRepoLock,
  type GitCredentials,
  type GitRunner,
} from "./worktree.js";

/** sdk 边界（测试注入 mock）；trySecret 为宽容读口（未注入返回 undefined，不抛错） */
export type WarmupDeps = {
  /** 登记表仓条目读口（生产 = () => loadRepoRegistry().repos；测试直接注入条目数组）。
   *  加载失败（文件缺失/非法）抛错 → 整体失败（登记表是必要输入） */
  repos: () => RepoEntry[];
  trySecret: (name: string) => string | undefined;
  /** 业务缓存根目录读口（入口透传 sdk.cacheDir） */
  cacheDir: () => string;
  log: (
    level: "error" | "warn" | "info" | "debug",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  /** git 执行器（缺省生产 execFile 实现；测试注入 fake） */
  git?: GitRunner;
};

/** 逐仓预热产出的一行（spec §4.3：每仓 { key, repo, repo_dir, action, duration_ms }） */
export type WarmupRepoResult = {
  /** 登记表条目 key（定位哪个仓） */
  key: string;
  /** 仓远端 URL（登记表 url 原样） */
  repo: string;
  /** bare 缓存目录（{cacheDir}/repos/{slug}） */
  repo_dir: string;
  /** 本轮动作：cloned = 冷仓首克隆；fetched = 热仓增量 fetch */
  action: "cloned" | "fetched";
  duration_ms: number;
};

/** 预热产出（入口经 sdk.return 写出；逐仓数组，排查时定位哪个仓没热） */
export type WarmupResult = {
  /** 成功仓的逐仓结果（失败仓不进数组，靠 warn 日志与 metrics.warmup_repos_failed 留痕） */
  repos: WarmupRepoResult[];
  /** metrics 平台保留键（结构不变：扁平 string|number map，平台剥离进 run_metrics） */
  metrics: {
    /** 登记表仓总数 */
    warmup_repos_total: number;
    /** 本轮预热失败仓数（>0 时应查 warn 日志定位是哪个仓） */
    warmup_repos_failed: number;
    /** 全部仓预热总耗时 */
    warmup_duration_ms: number;
  };
};

/** fetch/clone 命令的凭据注入前缀（两者齐备才注入 http.extraHeader 认证头）。
 *  与 worktree.ts 内部 credentialArgs 同款纪律——该函数是 worktree 的内部件未导出，
 *  此处按同款实现（小工具自留，不改 worktree 既有签名） */
function credentialArgs(credentials?: GitCredentials): string[] {
  if (!credentials?.username || !credentials?.token) {
    return [];
  }
  const basic = Buffer.from(
    `${credentials.username}:${credentials.token}`,
  ).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

/** 错误摘要脱敏（username/token/两者 base64 对替换为 [REDACTED]；同 worktree 纪律） */
function redactSecrets(text: string, credentials?: GitCredentials): string {
  let redacted = text;
  const secrets = [
    credentials?.username,
    credentials?.token,
    credentials?.username && credentials?.token
      ? Buffer.from(`${credentials.username}:${credentials.token}`).toString(
          "base64",
        )
      : undefined,
  ];
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted;
}

/** git 调用失败 → 带动作名与脱敏 stderr 摘要的错误（凭据绝不进错误信息） */
function gitFailure(
  action: string,
  stderr: string,
  credentials?: GitCredentials,
): Error {
  const summary = redactSecrets(stderr, credentials)
    .split("\n")
    .slice(0, 3)
    .join("；");
  return new Error(`${action}失败${summary ? `：${summary}` : ""}`);
}

/** 按条目 account 解析凭据（与主流程序同规则）：有账号名才宽容读一对 secrets；缺一按无凭据继续 */
function resolveEntryCredentials(
  entry: RepoEntry,
  deps: WarmupDeps,
): GitCredentials | undefined {
  if (!entry.account) {
    return undefined;
  }
  const username = deps.trySecret(`git_account_${entry.account}_username`);
  const token = deps.trySecret(`git_account_${entry.account}_token`);
  const credentials = resolveGitCredentials({
    account: entry.account,
    username,
    token,
  });
  if (!credentials) {
    deps.log("warn", "git 账号凭据不完整，按无凭据继续（公开仓场景）", {
      key: entry.key,
      account: entry.account,
      hasUsername: Boolean(username),
      hasToken: Boolean(token),
    });
  }
  return credentials;
}

/**
 * 预热单个仓：锁内（首克隆 | fetch）→ 机会性 prune。失败抛错（错误已脱敏），
 * 由 runWarmup 的逐仓 try/catch 捕获转 warn，不阻断其他仓。
 */
async function warmupOneRepo(args: {
  git: GitRunner;
  cacheDir: string;
  entry: RepoEntry;
  credentials?: GitCredentials;
}): Promise<WarmupRepoResult> {
  const { git, cacheDir, entry, credentials } = args;
  const repoDir = repoCacheDir(cacheDir, entry.url);
  const start = Date.now();

  let action: WarmupRepoResult["action"];
  if (!existsSync(repoDir)) {
    // 冷仓：锁内首克隆（{目标}.tmp-{pid} 临时目录 + renameSync 转正，防半成品）
    action = "cloned";
    await withRepoLock(cacheDir, async () => {
      if (existsSync(repoDir)) {
        return; // 等锁期间已被并发克隆
      }
      const tmpDir = `${repoDir}.tmp-${process.pid}`;
      const clone = await git([
        ...credentialArgs(credentials),
        "clone",
        "--bare",
        entry.url,
        tmpDir,
      ]);
      if (clone.code !== 0) {
        rmSync(tmpDir, { recursive: true, force: true });
        throw gitFailure("克隆源码仓", clone.stderr, credentials);
      }
      renameSync(tmpDir, repoDir);
    });
  } else {
    // 热仓：锁内增量 fetch（一律 --no-tags；缓存仓单 origin）
    action = "fetched";
    const fetchResult = await withRepoLock(cacheDir, () =>
      git([
        "-C",
        repoDir,
        ...credentialArgs(credentials),
        "fetch",
        "--no-tags",
        "origin",
      ]),
    );
    if (fetchResult.code !== 0) {
      throw gitFailure("预热 fetch", fetchResult.stderr, credentials);
    }
  }

  // 机会性 prune：清理 worktree 元数据残留（检出目录随 run 删除后注册项残留）；失败忽略
  try {
    await git(["-C", repoDir, "worktree", "prune"]);
  } catch {
    // 机会操作：失败忽略
  }

  return {
    key: entry.key,
    repo: entry.url,
    repo_dir: repoDir,
    action,
    duration_ms: Date.now() - start,
  };
}

/**
 * 执行一轮预热：读登记表 → 逐仓（解析凭据 → 锁内首克隆|fetch → 机会性 prune）。
 * 单仓失败：warn 留痕（含 key 与脱敏错误）后继续下一仓，不整体失败；
 * 登记表加载失败（必要输入缺失）→ 抛错（入口映射 sdk.fail）。
 */
export async function runWarmup(deps: WarmupDeps): Promise<WarmupResult> {
  const git = deps.git ?? defaultGitRunner;
  const cacheDir = deps.cacheDir();
  const repos = deps.repos();
  const start = Date.now();

  const results: WarmupRepoResult[] = [];
  let failed = 0;
  for (const entry of repos) {
    try {
      const credentials = resolveEntryCredentials(entry, deps);
      const result = await warmupOneRepo({ git, cacheDir, entry, credentials });
      results.push(result);
      deps.log("info", "仓预热完成", {
        key: result.key,
        repo: result.repo,
        repoDir: result.repo_dir,
        action: result.action,
        durationMs: result.duration_ms,
      });
    } catch (error) {
      failed += 1;
      // 单仓失败不阻断（spec §4.3）：错误信息已经脱敏（gitFailure 纪律），可安全入日志
      const message = error instanceof Error ? error.message : String(error);
      deps.log("warn", "仓预热失败（跳过，继续下一仓）", {
        key: entry.key,
        repo: entry.url,
        errorMessage: message,
      });
    }
  }

  return {
    repos: results,
    metrics: {
      warmup_repos_total: repos.length,
      warmup_repos_failed: failed,
      warmup_duration_ms: Date.now() - start,
    },
  };
}

/** 供测试与入口共用的宽容读口构造：sdk.secret 抛错（未注入）→ undefined */
export function trySecretOf(
  secret: (name: string) => string,
): (name: string) => string | undefined {
  return (name) => {
    try {
      return secret(name);
    } catch {
      return undefined;
    }
  };
}
