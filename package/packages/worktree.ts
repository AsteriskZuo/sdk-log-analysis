/**
 * git worktree 管理（spec §6.6，2026-11-13 重设计：远端 URL + bare 缓存 + 锁协议）。
 *
 * - 仓来源：repoUrl（控制台登记的远端 URL，如 https://github.com/easemob/emclient-linux）。
 *   业务只认 URL，仓怎么来的（克隆/预热）是缓存层的事。本机仓路径假设
 *   （sdk_repo_path）、ALLOWED_REMOTES 白名单与「沿用本机 remote 凭据」分支随之
 *   废除——缓存仓 remote 恒为单 origin（= repoUrl）；实测本机仓 remote 名
 *   （asterisk/easemob 而非 origin）佐证「沿用本机配置」不可靠。
 * - 缓存结构：bare 仓缓存于 {cacheDir}/repos/{slug}/（slug = URL 归一化目录名，
 *   见 repoSlug）。bare 无主检出、含全部分支与 tag，体积最小；跨 run 保留、不做
 *   TTL（保活归预热定时任务，与本模块共用同一把锁，决策 D10）。
 * - 锁协议：{cacheDir}/repos/.lock 用 mkdirSync 原子获取；EEXIST 时看 mtime，
 *   超 10 分钟视为崩溃残留（rmdir 收割后重试一次，再失败抛「锁被占用」）；
 *   finally rmdirSync 释放。锁只保护两个动作：首克隆（clone 到 {目标}.tmp-{pid}
 *   成功后 renameSync 转正，防半成品）与 fetch（含精确 ref fetch）。worktree
 *   add / prune 不加应用锁——git 内部锁保护元数据，prune 为机会操作（失败忽略）。
 * - ref 解析阶梯（全部在 bare 仓上执行，一律 --no-tags，单 origin）：
 *   1) 本地 rev-parse --verify {ref}^{commit}；
 *   2) 解析不到 → 锁内 git fetch --no-tags origin → 再解析；
 *   3) 仍失败且 ref 是裸版本号（^\d+\.\d+(\.\d+)?$）→ 归一化 SDK_{ref} 重试 1)+2) 一次
 *      （真 e2e 实证：叙述里的裸版本号常是另一仓的 tag，verbatim 解析不到）；
 *   4) 仍失败 → 锁内 git fetch --no-tags origin {ref} 精确 ref，用校验过的 FETCH_HEAD 检出；
 *   5) 最终失败 → 抛「无法解析 git ref」错误（ref + 脱敏 git stderr 摘要）。
 * - 检出：git -C {缓存仓} worktree add --detach {workspace}/{sourceSubdir} {commit}
 *   （detached HEAD，不动任何分支/标签；每个 run 检出各自 commit，无「切换分支」
 *   动作，并发天然安全）。add 前机会性 worktree prune；add 后 rev-parse HEAD 校验。
 * - 凭据纪律（key 按账号，决策 D11）：clone/fetch 以
 *   http.extraHeader=Authorization: Basic … 形式挂命令行（不落盘、不进 URL）；
 *   **凭据绝不进日志/错误信息**——本模块不打日志，抛出的错误只含 ref 与脱敏后的
 *   git stderr 摘要。从信封宽容读 secrets 归编排层（缺一 = 未配置，公开仓场景
 *   按无凭据继续；代码不做「公开仓 = 无账号」限制），resolveGitCredentials 组装。
 * - git 执行器注入式（测试可 mock）；所有 git 调用经同一 runner。
 * - 清理：worktree 在 run workspace 内，随 run 目录生命周期走，业务不做额外清理。
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/** git 执行结果（非零退出不抛错，由调用方判别——merge-base 等要靠 code 判断） */
export type GitRunResult = { code: number; stdout: string; stderr: string };

/** git 执行器：args 为完整 git 参数表（含 -C 与 -c），返回捕获的 stdout/stderr 与退出码 */
export type GitRunner = (args: string[]) => Promise<GitRunResult>;

/** 私有仓凭据（可选；username/token 两者齐备才注入，缺一视为未配置） */
export type GitCredentials = { username?: string; token?: string };

/** 生产执行器：异步 execFile（同步 exec 会阻塞事件循环——jest 进程内 mock server 场景教训） */
export const defaultGitRunner: GitRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error); // spawn 级失败（git 不存在等）
          return;
        }
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout: String(stdout).trim(),
          stderr: String(stderr).trim(),
        });
      },
    );
  });

export type WorktreeResult = {
  /** worktree 检出目录（{workspace}/{sourceSubdir}） */
  sourceDir: string;
  /** 检出 HEAD commit sha */
  commitSha: string;
  /** true = 目录已存在直接复用（未执行任何 fetch/add） */
  reused: boolean;
  /** true = 本轮对 origin 实际 fetch 成功过（供日志区分冷热路径） */
  fetched: boolean;
};

const SAFE_REF_PATTERN = /^[A-Za-z0-9._/@-]+$/;
const SAFE_SUBDIR_PATTERN = /^[A-Za-z0-9._/-]+$/;
/** 裸版本号 ref（阶梯第 3 步归一化重试的判据；spec §6.5/§6.6） */
const BARE_VERSION_PATTERN = /^\d+\.\d+(\.\d+)?$/;
/** 残留锁收割阈值：mtime 超 10 分钟视为崩溃残留（正常 fetch 秒级；首克隆慢网
 *  可超阈值被误收割，属协议接受的极端取舍，release 失败静默不掩盖原错误） */
const LOCK_STALE_MS = 10 * 60 * 1000;

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

/** git 调用失败 → 带 ref 与脱敏 stderr 摘要的错误（凭据绝不进错误信息） */
function gitFailure(
  action: string,
  ref: string,
  stderr: string,
  credentials?: GitCredentials,
): Error {
  const summary = redactSecrets(stderr, credentials)
    .split("\n")
    .slice(0, 3)
    .join("；");
  return new Error(
    `${action}失败（ref=${ref}）${summary ? `：${summary}` : ""}`,
  );
}

/** clone/fetch 命令的凭据注入前缀（两者齐备才注入 http.extraHeader 认证头） */
function credentialArgs(credentials?: GitCredentials): string[] {
  if (!credentials?.username || !credentials?.token) {
    return [];
  }
  const basic = Buffer.from(
    `${credentials.username}:${credentials.token}`,
  ).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

/**
 * 组装 git 凭据（spec §6.6 凭据纪律，key 按账号）：account/username/token 三值
 * 齐备才返回凭据对象，否则 undefined（缺一个 = 未配置，按无凭据继续）。
 * 纯函数；从信封宽容读 secrets（try/catch sdk.secret）归编排层。
 */
export function resolveGitCredentials(args: {
  account?: string;
  username?: string;
  token?: string;
}): GitCredentials | undefined {
  if (!args.account || !args.username || !args.token) {
    return undefined;
  }
  return { username: args.username, token: args.token };
}

/** URL 归一化目录名：剥协议（http(s):// 剥除；git@host:path 先转 host/path 标准形）、
 *  剥尾部 .git 与尾部斜杠、"/" 与 ":" 转 "-"，如 github.com-easemob-emclient-linux */
export function repoSlug(repoUrl: string): string {
  let normalized = repoUrl.trim();
  const scpLike = /^[^/@]+@([^:]+):(.+)$/.exec(normalized);
  if (scpLike) {
    normalized = `${scpLike[1]}/${scpLike[2]}`;
  }
  normalized = normalized.replace(/^https?:\/\//i, "");
  normalized = normalized.replace(/\/+$/, "");
  normalized = normalized.replace(/\.git$/i, "");
  const slug = normalized.replace(/[/:]+/g, "-");
  if (slug === "") {
    throw new Error(`非法 git 仓 URL：${repoUrl}`);
  }
  return slug;
}

/** bare 缓存目录：{cacheDir}/repos/{slug}（预热脚本与本模块共用此定位） */
export function repoCacheDir(cacheDir: string, repoUrl: string): string {
  return path.join(cacheDir, "repos", repoSlug(repoUrl));
}

/**
 * 仓缓存锁（mkdir 原子锁；spec §6.6 锁协议）：只保护「首克隆」与「fetch」两个动作，
 * 预热定时任务与运行时共用本函数（决策 D10）。EEXIST 时按 mtime 收割超
 * LOCK_STALE_MS 的崩溃残留后重试一次，再失败抛「锁被占用」；finally 释放
 * （释放失败静默——锁可能已被收割方清掉，不得掩盖 fn 的结果/错误）。
 */
export async function withRepoLock<T>(
  cacheDir: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const reposDir = path.join(cacheDir, "repos");
  mkdirSync(reposDir, { recursive: true });
  const lockPath = path.join(reposDir, ".lock");
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
    try {
      mkdirSync(lockPath);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (attempt > 0) {
        break;
      }
      // 残留收割：mtime 超阈值才删；新鲜锁（并发持有中）直接落到占用错误
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        // stat 失败（竞态中刚被释放）：按非残留处理
      }
      if (stale) {
        try {
          rmdirSync(lockPath);
        } catch {
          // 删除失败（竞态）：下轮 mkdir 仍 EEXIST，落占用错误
        }
      } else {
        break;
      }
    }
  }
  if (!acquired) {
    throw new Error(
      `仓缓存锁被占用：${lockPath}（可能存在并发克隆/fetch；若确认为崩溃残留可删除该目录）`,
    );
  }
  try {
    return await fn();
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      // 锁已被外部收割/清理：静默（不得掩盖 fn 的结果）
    }
  }
}

/** rev-parse --verify {ref}^{commit}，解析到返回 sha，否则 undefined */
async function verifyCommit(
  git: GitRunner,
  repoPath: string,
  ref: string,
): Promise<string | undefined> {
  const result = await git([
    "-C",
    repoPath,
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]);
  return result.code === 0 && result.stdout !== "" ? result.stdout : undefined;
}

/**
 * 准备 worktree：确保 bare 缓存（缺则锁内克隆）→ ref 解析阶梯（本地 → 锁内
 * fetch --no-tags origin → 裸版本号 SDK_ 归一化重试一次 → 精确 ref FETCH_HEAD）
 * → worktree add --detach。
 * 任何一步最终失败抛 Error（ref + 脱敏 git 错误摘要），由编排映射 sdk.fail。
 */
export async function prepareWorktree(args: {
  /** 源码仓远端 URL（命中登记表条目的 url；缓存仓唯一 origin） */
  repoUrl: string;
  /** 业务缓存根目录（sdk.cacheDir()；bare 仓落在 {cacheDir}/repos/{slug}） */
  cacheDir: string;
  workspace: string;
  ref: string;
  /** 检出子目录（相对 workspace），缺省 "source" */
  sourceSubdir?: string;
  /** 可选私有仓凭据（clone/fetch 以 http.extraHeader 注入；缺省 = 匿名） */
  credentials?: GitCredentials;
  git?: GitRunner;
}): Promise<WorktreeResult> {
  const git = args.git ?? defaultGitRunner;
  const cacheDir = path.resolve(args.cacheDir);
  const workspace = path.resolve(args.workspace);
  const ref = args.ref;
  const sourceSubdir = args.sourceSubdir ?? "source";
  const credentials = args.credentials;

  if (!SAFE_REF_PATTERN.test(ref)) {
    throw new Error(`非法 git ref：${ref}`);
  }
  if (
    !SAFE_SUBDIR_PATTERN.test(sourceSubdir) ||
    sourceSubdir.startsWith("/") ||
    sourceSubdir.split("/").includes("..")
  ) {
    throw new Error(`非法 worktree 子目录：${sourceSubdir}`);
  }
  const sourceDir = path.join(workspace, sourceSubdir);
  const relative = path.relative(workspace, sourceDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`worktree 路径逃逸 workspace：${sourceDir}`);
  }

  // 幂等复用：目录已存在直接报 HEAD（同 run 重入/审计重复准备场景）；不触碰缓存仓
  if (existsSync(sourceDir)) {
    const head = await git(["-C", sourceDir, "rev-parse", "HEAD"]);
    if (head.code !== 0) {
      throw gitFailure("读取既有 worktree HEAD", ref, head.stderr, credentials);
    }
    return { sourceDir, commitSha: head.stdout, reused: true, fetched: false };
  }

  const repoDir = repoCacheDir(cacheDir, args.repoUrl);

  // 首克隆（锁内，锁协议动作之一）：{目标}.tmp-{pid} 临时目录，成功后 renameSync
  // 转正（防半成品）；失败清理临时目录。等锁期间可能已被并发克隆 → 锁内复检
  if (!existsSync(repoDir)) {
    await withRepoLock(cacheDir, async () => {
      if (existsSync(repoDir)) {
        return;
      }
      const tmpDir = `${repoDir}.tmp-${process.pid}`;
      const clone = await git([
        ...credentialArgs(credentials),
        "clone",
        "--bare",
        args.repoUrl,
        tmpDir,
      ]);
      if (clone.code !== 0) {
        rmSync(tmpDir, { recursive: true, force: true });
        throw gitFailure("克隆源码仓", ref, clone.stderr, credentials);
      }
      renameSync(tmpDir, repoDir);
    });
  }

  // ref 解析阶梯（一律 --no-tags，缓存仓单 origin；fetch 全在锁内，锁协议动作之二）
  let fetched = false;
  let lastFetchError: string | undefined;
  const fetchOrigin = async (): Promise<void> => {
    const result = await withRepoLock(cacheDir, () =>
      git([
        "-C",
        repoDir,
        ...credentialArgs(credentials),
        "fetch",
        "--no-tags",
        "origin",
      ]),
    );
    if (result.code === 0) {
      fetched = true;
    } else {
      lastFetchError = result.stderr;
    }
  };

  let commitSha = await verifyCommit(git, repoDir, ref);
  let checkoutRef = ref;

  if (!commitSha) {
    await fetchOrigin();
    commitSha = await verifyCommit(git, repoDir, ref);
  }

  // 裸版本号归一化重试一次（SDK_{version} tag；阶梯第 3 步，重试「本地 + fetch」）
  if (!commitSha && BARE_VERSION_PATTERN.test(ref)) {
    const normalized = `SDK_${ref}`;
    commitSha = await verifyCommit(git, repoDir, normalized);
    if (!commitSha) {
      await fetchOrigin();
      commitSha = await verifyCommit(git, repoDir, normalized);
    }
    if (commitSha) {
      checkoutRef = normalized;
    }
  }

  if (!commitSha) {
    // 精确 ref 单独 fetch（锁内），用校验过的 FETCH_HEAD 检出
    const exactRef = ref.startsWith("origin/")
      ? ref.slice("origin/".length)
      : ref;
    const fetchResult = await withRepoLock(cacheDir, () =>
      git([
        "-C",
        repoDir,
        ...credentialArgs(credentials),
        "fetch",
        "--no-tags",
        "origin",
        exactRef,
      ]),
    );
    if (fetchResult.code === 0) {
      fetched = true;
      const fetchedSha = await verifyCommit(git, repoDir, "FETCH_HEAD");
      if (fetchedSha) {
        commitSha = fetchedSha;
        checkoutRef = fetchedSha;
      }
    } else {
      lastFetchError = fetchResult.stderr;
    }
  }

  if (!commitSha) {
    const summary = lastFetchError
      ? redactSecrets(lastFetchError, credentials)
          .split("\n")
          .slice(0, 3)
          .join("；")
      : "";
    throw new Error(
      `无法解析 git ref（fetch origin 后仍不存在）：${ref}${summary ? `：${summary}` : ""}`,
    );
  }

  await mkdir(workspace, { recursive: true });
  // 机会性 prune：清理 worktree 元数据残留（检出目录随 run 删除后注册项残留）；失败忽略
  try {
    await git(["-C", repoDir, "worktree", "prune"]);
  } catch {
    // 机会操作：失败忽略
  }
  const add = await git([
    "-C",
    repoDir,
    "worktree",
    "add",
    "--detach",
    sourceDir,
    checkoutRef,
  ]);
  if (add.code !== 0) {
    throw gitFailure("worktree add", ref, add.stderr, credentials);
  }

  const head = await git(["-C", sourceDir, "rev-parse", "HEAD"]);
  if (head.code !== 0) {
    throw gitFailure("读取 worktree HEAD", ref, head.stderr, credentials);
  }
  return { sourceDir, commitSha: head.stdout, reused: false, fetched };
}

/** 校验 sha 是 baseRef 的祖先（mainline 审计的 fix_commit 验证用） */
export async function gitIsAncestor(
  git: GitRunner,
  repoPath: string,
  sha: string,
  baseRef: string,
): Promise<boolean> {
  const result = await git([
    "-C",
    repoPath,
    "merge-base",
    "--is-ancestor",
    sha,
    baseRef,
  ]);
  return result.code === 0;
}

/** rev-parse --verify 规范化 sha（7–40 位 hex 才接受），失败返回 undefined */
export async function gitVerifySha(
  git: GitRunner,
  repoPath: string,
  sha: string,
): Promise<string | undefined> {
  const candidate = sha.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(candidate)) {
    return undefined;
  }
  return verifyCommit(git, repoPath, candidate);
}

export type CommitMetadata = {
  sha: string;
  subject: string;
  author: string;
  date: string;
};

/** git show 规范元数据（替换模型自述；字段缺一视为不可用） */
export async function gitShowMetadata(
  git: GitRunner,
  repoPath: string,
  sha: string,
): Promise<CommitMetadata | undefined> {
  const result = await git([
    "-C",
    repoPath,
    "show",
    "-s",
    "--format=%H%x00%s%x00%an%x00%aI",
    sha,
  ]);
  if (result.code !== 0) {
    return undefined;
  }
  const fields = result.stdout.split("\0");
  if (fields.length !== 4 || fields.some((field) => !field)) {
    return undefined;
  }
  return {
    sha: fields[0],
    subject: fields[1],
    author: fields[2],
    date: fields[3],
  };
}
