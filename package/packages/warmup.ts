/**
 * 仓预热（spec docs/specs/2026-11-13-scheduled-task-spec.md §4.8 / 决策 D10）：
 * 平台定时任务规则触发的无事件 run（main-only 阶段），把慢操作（克隆/fetch）挪到
 * 闲时，保持 {cacheDir}/repos/{slug} 的 bare 缓存新鲜，事件 run 的 prepareWorktree
 * 因此命中热仓（worktree add ~1.5s）。
 *
 * 与运行时共用同一把锁与同一份协议（决策 D10）：锁/定位/凭据组装全部 import
 * worktree.ts 已导出件（repoCacheDir/withRepoLock/resolveGitCredentials），
 * 不改其任何签名。锁内动作：无缓存 → 首克隆（{目标}.tmp-{pid} 临时目录 +
 * renameSync 转正，防半成品，照 D9）；有缓存 → git fetch --no-tags origin。
 * 随后机会性 worktree prune（失败忽略）。
 *
 * 凭据纪律与主流程序完全一致（决策 D11）：普通桶 sdk_repo_account（账号名）+
 * 安全桶 git_account_{账号}_username/token 一对，宽容读（缺 key 按无凭据继续，
 * 公开仓场景；绝不强制读 secrets）。凭据只以 http.extraHeader 挂命令行，
 * 绝不进日志/错误信息（错误摘要经脱敏）。
 *
 * 任何失败抛错，由入口（apps/warmup）映射 sdk.fail。
 */

import { existsSync, renameSync, rmSync } from "node:fs";
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
  config: () => Record<string, string>;
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

/** 预热产出（入口经 sdk.return 写出；metrics 为平台保留键，动作与耗时进统计） */
export type WarmupResult = {
  /** 预热的仓远端 URL（config.sdk_repo_url 原样） */
  repo: string;
  /** bare 缓存目录（{cacheDir}/repos/{slug}） */
  repo_dir: string;
  /** 本轮动作：cloned = 冷仓首克隆；fetched = 热仓增量 fetch */
  action: "cloned" | "fetched";
  duration_ms: number;
  metrics: {
    warmup_action: string;
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

/**
 * 执行一轮预热：读配置 → 解析凭据 → 锁内（首克隆 | fetch）→ 机会性 prune。
 * 缺 sdk_repo_url / 非 http(s) URL / git 操作失败 / 锁被占用 → 抛错（入口映射 sdk.fail）。
 */
export async function runWarmup(deps: WarmupDeps): Promise<WarmupResult> {
  const git = deps.git ?? defaultGitRunner;
  const config = deps.config();

  const repoUrl = config.sdk_repo_url ?? "";
  if (!/^https?:\/\//.test(repoUrl)) {
    throw new Error(
      "config.sdk_repo_url 缺失或不是 http(s) URL（控制台登记该仓远端地址，如 https://github.com/easemob/emclient-linux）",
    );
  }

  // 凭据（D11，与主流程序同规则）：有账号名才宽容读一对 secrets；缺一按无凭据继续
  const account = config.sdk_repo_account;
  let credentials: GitCredentials | undefined;
  if (account) {
    const username = deps.trySecret(`git_account_${account}_username`);
    const token = deps.trySecret(`git_account_${account}_token`);
    credentials = resolveGitCredentials({ account, username, token });
    if (!credentials) {
      deps.log("warn", "git 账号凭据不完整，按无凭据继续（公开仓场景）", {
        account,
        hasUsername: Boolean(username),
        hasToken: Boolean(token),
      });
    }
  }

  const cacheDir = deps.cacheDir();
  const repoDir = repoCacheDir(cacheDir, repoUrl);
  const start = Date.now();

  let action: WarmupResult["action"];
  if (!existsSync(repoDir)) {
    // 冷仓：锁内首克隆（{目标}.tmp-{pid} 临时目录 + renameSync 转正，防半成品；D9 协议）
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
        repoUrl,
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

  const durationMs = Date.now() - start;
  deps.log("info", "仓预热完成", {
    repo: repoUrl,
    repoDir,
    action,
    durationMs,
  });
  return {
    repo: repoUrl,
    repo_dir: repoDir,
    action,
    duration_ms: durationMs,
    metrics: { warmup_action: action, warmup_duration_ms: durationMs },
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
