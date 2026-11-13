import { describe, expect, it, jest } from "@jest/globals";
import { existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoEntry } from "../packages/repos.js";
import { runWarmup, type WarmupDeps } from "../packages/warmup.js";
import type { GitRunResult, GitRunner } from "../packages/worktree.js";

const LINUX: RepoEntry = {
  key: "linux",
  url: "https://github.com/easemob/emclient-linux",
  mainline_ref: "msync",
  assignee_tag: "sdk",
  match: ["linux"],
};
const IOS: RepoEntry = {
  key: "ios",
  url: "https://github.com/easemob/emclient-ios",
  mainline_ref: "chatsdk",
  assignee_tag: "sdk",
  match: ["ios"],
};
const SLUG: Record<string, string> = {
  linux: "github.com-easemob-emclient-linux",
  ios: "github.com-easemob-emclient-ios",
};

type Answer = GitRunResult | ((args: string[]) => GitRunResult);

/** 可编程 fake git（照 worktree.test.ts 模式）：按调用序消费应答，函数形应答可做副作用 */
function fakeGit(answers: Answer[]): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...answers];
  const git = jest.fn(async (args: string[]) => {
    calls.push(args);
    const next = queue.shift();
    if (!next) {
      throw new Error(`fake git 应答耗尽：${args.join(" ")}`);
    }
    return typeof next === "function" ? next(args) : next;
  }) as unknown as GitRunner;
  return { git, calls };
}

const ok = (stdout = ""): GitRunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): GitRunResult => ({
  code: 1,
  stdout: "",
  stderr,
});

/** 建测试目录：cacheDir（业务缓存根）；warm = 预建 bare 缓存的仓 key 列表（热仓） */
async function makeDirs(opts: { warm?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "warmup-test-"));
  const cacheDir = join(root, "cache");
  for (const key of opts.warm ?? []) {
    await mkdir(join(cacheDir, "repos", SLUG[key]), { recursive: true });
  }
  const repoDir = (key: string) => join(cacheDir, "repos", SLUG[key]);
  return { root, cacheDir, repoDir };
}

/** clone 应答：真建临时目录（renameSync 的对象） */
function cloneOk(args: string[]): GitRunResult {
  mkdirSync(args[args.length - 1], { recursive: true });
  return ok("");
}

function makeDeps(
  cacheDir: string,
  overrides: Partial<WarmupDeps> = {},
): {
  deps: WarmupDeps;
  logs: { level: string; message: string; fields?: Record<string, unknown> }[];
} {
  const logs: {
    level: string;
    message: string;
    fields?: Record<string, unknown>;
  }[] = [];
  const deps: WarmupDeps = {
    repos: () => [LINUX, IOS],
    trySecret: () => undefined,
    cacheDir: () => cacheDir,
    log: (level, message, fields) => {
      logs.push({ level, message, ...(fields ? { fields } : {}) });
    },
    ...overrides,
  };
  return { deps, logs };
}

describe("runWarmup（多仓登记表 spec §4.3：遍历登记表逐仓预热）", () => {
  it("多仓混合：冷仓锁内 clone --bare 转正、热仓锁内 fetch --no-tags，逐仓产出 + metrics", async () => {
    const { cacheDir, repoDir } = await makeDirs({ warm: ["ios"] });
    const { git, calls } = fakeGit([
      cloneOk, // linux：clone --bare
      ok(""), // linux：worktree prune（机会操作）
      ok(""), // ios：fetch --no-tags origin（锁内）
      ok(""), // ios：worktree prune
    ]);
    const { deps } = makeDeps(cacheDir, { git });

    const result = await runWarmup(deps);

    // 逐仓数组（spec §4.3：每仓 { key, repo, repo_dir, action, duration_ms }）
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0]).toMatchObject({
      key: "linux",
      repo: LINUX.url,
      repo_dir: repoDir("linux"),
      action: "cloned",
    });
    expect(result.repos[1]).toMatchObject({
      key: "ios",
      repo: IOS.url,
      repo_dir: repoDir("ios"),
      action: "fetched",
    });
    expect(typeof result.repos[0].duration_ms).toBe("number");
    expect(typeof result.repos[1].duration_ms).toBe("number");
    // metrics 保留键（扁平 map）
    expect(result.metrics.warmup_repos_total).toBe(2);
    expect(result.metrics.warmup_repos_failed).toBe(0);
    expect(typeof result.metrics.warmup_duration_ms).toBe("number");
    // clone 命令拼装：--bare + 原样 URL + 临时目录（.tmp-{pid} 后缀）；fetch 不带 --tags
    expect(calls[0]).toEqual([
      "clone",
      "--bare",
      LINUX.url,
      `${repoDir("linux")}.tmp-${process.pid}`,
    ]);
    expect(calls[2]).toEqual([
      "-C",
      repoDir("ios"),
      "fetch",
      "--no-tags",
      "origin",
    ]);
    expect(calls.some((args) => args.includes("--tags"))).toBe(false);
    // rename 转正 + 锁已释放
    expect(existsSync(repoDir("linux"))).toBe(true);
    expect(existsSync(join(cacheDir, "repos", ".lock"))).toBe(false);
  });

  it("单仓 fetch 失败：warn 留痕（含 key），不阻断其他仓，产出只含成功仓", async () => {
    const { cacheDir } = await makeDirs({ warm: ["linux", "ios"] });
    const { git, calls } = fakeGit([
      () => fail("fatal: could not read remote"), // linux fetch 失败
      ok(""), // ios fetch
      ok(""), // ios prune
    ]);
    const { deps, logs } = makeDeps(cacheDir, { git });

    const result = await runWarmup(deps);

    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].key).toBe("ios");
    expect(result.metrics.warmup_repos_total).toBe(2);
    expect(result.metrics.warmup_repos_failed).toBe(1);
    // 每仓开始/完成各留一条日志（进度可读：x/6 语义）
    const startLog = logs.find(
      (l) => l.level === "info" && l.message === "开始仓预热",
    );
    expect(startLog?.fields?.index).toBe(1);
    expect(startLog?.fields?.total).toBe(2);
    expect(
      logs.some(
        (l) =>
          l.level === "warn" &&
          l.message === "仓预热失败（跳过，继续下一仓）" &&
          l.fields?.key === "linux" &&
          String(l.fields?.errorMessage).includes("预热 fetch失败"),
      ),
    ).toBe(true);
    // ios 正常走完（fetch + prune），linux 失败不带累后续仓
    expect(calls).toHaveLength(3);
    expect(existsSync(join(cacheDir, "repos", ".lock"))).toBe(false);
  });

  it("单仓冷克隆失败：清理临时目录 + warn，继续下一仓", async () => {
    const { cacheDir, repoDir } = await makeDirs({ warm: ["ios"] });
    const { git } = fakeGit([
      () => fail("fatal: auth failed"), // linux clone 失败
      ok(""), // ios fetch
      ok(""), // ios prune
    ]);
    const { deps, logs } = makeDeps(cacheDir, { git });

    const result = await runWarmup(deps);

    expect(result.repos.map((r) => r.key)).toEqual(["ios"]);
    expect(result.metrics.warmup_repos_failed).toBe(1);
    expect(
      logs.some(
        (l) =>
          l.level === "warn" &&
          l.fields?.key === "linux" &&
          String(l.fields?.errorMessage).includes("克隆源码仓失败"),
      ),
    ).toBe(true);
    // 临时目录已清理、正式目录不存在、锁已释放
    expect(existsSync(repoDir("linux"))).toBe(false);
    expect(existsSync(`${repoDir("linux")}.tmp-${process.pid}`)).toBe(false);
    expect(existsSync(join(cacheDir, "repos", ".lock"))).toBe(false);
  });

  it("凭据按条目 account 解析：齐备 → clone/fetch 带 http.extraHeader；缺一 → warn + 无注入", async () => {
    // 齐备：linux 带 account + 一对 secrets
    const cold = await makeDirs();
    const { git, calls } = fakeGit([cloneOk, ok("")]);
    const { deps } = makeDeps(cold.cacheDir, {
      git,
      repos: () => [{ ...LINUX, account: "ci-bot" }],
      trySecret: (name) =>
        name === "git_account_ci-bot_username"
          ? "bot-user"
          : name === "git_account_ci-bot_token"
            ? "secret-token"
            : undefined,
    });
    await runWarmup(deps);
    const expectedBasic = Buffer.from("bot-user:secret-token").toString(
      "base64",
    );
    expect(calls[0].slice(0, 2)).toEqual([
      "-c",
      `http.extraHeader=Authorization: Basic ${expectedBasic}`,
    ]);

    // 缺一（token 未注入）：warn 留痕（含 key）+ 按无凭据 fetch（公开仓场景）
    const warm = await makeDirs({ warm: ["linux"] });
    const plain = fakeGit([ok(""), ok("")]);
    const { deps: plainDeps, logs } = makeDeps(warm.cacheDir, {
      git: plain.git,
      repos: () => [{ ...LINUX, account: "ci-bot" }],
      trySecret: (name) =>
        name === "git_account_ci-bot_username" ? "bot-user" : undefined,
    });
    await runWarmup(plainDeps);
    expect(
      logs.some(
        (l) =>
          l.level === "warn" &&
          l.message === "git 账号凭据不完整，按无凭据继续（公开仓场景）" &&
          l.fields?.key === "linux" &&
          l.fields?.hasUsername === true &&
          l.fields?.hasToken === false,
      ),
    ).toBe(true);
    const fetchArgs = plain.calls[0];
    expect(fetchArgs.some((a) => a.includes("http.extraHeader"))).toBe(false);
  });

  it("单仓失败 warn 的错误摘要脱敏（凭据绝不进日志）", async () => {
    const { cacheDir } = await makeDirs({ warm: ["linux"] });
    const basic = Buffer.from("bot-user:secret-token").toString("base64");
    const { git } = fakeGit([
      () => fail(`fatal: auth failed for secret-token / bot-user / ${basic}`),
    ]);
    const { deps, logs } = makeDeps(cacheDir, {
      git,
      repos: () => [{ ...LINUX, account: "ci-bot" }],
      trySecret: (name) =>
        name === "git_account_ci-bot_username"
          ? "bot-user"
          : name === "git_account_ci-bot_token"
            ? "secret-token"
            : undefined,
    });

    const result = await runWarmup(deps);

    expect(result.metrics.warmup_repos_failed).toBe(1);
    const warn = logs.find(
      (l) =>
        l.level === "warn" && l.message === "仓预热失败（跳过，继续下一仓）",
    );
    expect(warn).toBeDefined();
    const errorMessage = String(warn!.fields?.errorMessage);
    expect(errorMessage).toContain("预热 fetch失败");
    expect(errorMessage).not.toContain("secret-token");
    expect(errorMessage).not.toContain("bot-user");
    expect(errorMessage).not.toContain(basic);
    expect(errorMessage).toContain("[REDACTED]");
  });

  it("单仓锁被并发持有（新鲜锁）：该仓 warn 跳过，其他仓不受影响", async () => {
    const { cacheDir } = await makeDirs({ warm: ["ios"] });
    // 预置新鲜锁：linux（第一仓）拿锁失败记 warn；warn 落日志时释放锁
    // （模拟并发方完成），ios（第二仓）正常拿锁预热
    const lockDir = join(cacheDir, "repos", ".lock");
    await mkdir(lockDir, { recursive: true });
    const { git } = fakeGit([
      ok(""), // ios fetch
      ok(""), // ios prune
    ]);
    const { deps, logs } = makeDeps(cacheDir, { git });
    const baseLog = deps.log;
    deps.log = (level, message, fields) => {
      baseLog(level, message, fields);
      if (message === "仓预热失败（跳过，继续下一仓）") {
        rmdirSync(lockDir);
      }
    };

    const result = await runWarmup(deps);

    expect(result.repos.map((r) => r.key)).toEqual(["ios"]);
    expect(result.metrics.warmup_repos_failed).toBe(1);
    expect(
      logs.some(
        (l) =>
          l.level === "warn" &&
          l.fields?.key === "linux" &&
          String(l.fields?.errorMessage).includes("仓缓存锁被占用"),
      ),
    ).toBe(true);
  });

  it("登记表加载失败（必要输入缺失）→ 整体抛错（不执行 git）", async () => {
    const { cacheDir } = await makeDirs();
    const { git, calls } = fakeGit([]);
    await expect(
      runWarmup(
        makeDeps(cacheDir, {
          git,
          repos: () => {
            throw new Error("仓库登记表读取失败：/x/repos.json");
          },
        }).deps,
      ),
    ).rejects.toThrow(/仓库登记表读取失败/);
    expect(calls).toEqual([]);
  });
});

describe("agent-package.json 定时任务契约（spec §4.8 清单写法）", () => {
  const manifest = JSON.parse(
    readFileSync(
      // 编译产物位于 dist-test/tests/：上两级到包根（与源码 tests/ 上一级不同位）
      new URL("../../agent-package.json", import.meta.url),
      "utf8",
    ),
  ) as {
    programs: Record<string, string>;
    scheduled_tasks?: {
      name: string;
      program: string;
      every_minutes: number;
      timeout_minutes?: number;
    }[];
  };

  it("programs 含 warmup 且指向 dist 产物", () => {
    expect(manifest.programs.warmup).toBe("dist/apps/warmup/index.js");
  });

  it("scheduled_tasks 声明合规：单任务 warmup，字段齐全且 program ∈ programs 键", () => {
    expect(manifest.scheduled_tasks).toEqual([
      {
        name: "warmup",
        program: "warmup",
        every_minutes: 720,
        timeout_minutes: 60,
      },
    ]);
    for (const task of manifest.scheduled_tasks ?? []) {
      // 平台校验口径（spec §4.2）：name 非空、program ∈ programs、整数分钟 ≥1
      expect(task.name.length).toBeGreaterThan(0);
      expect(task.name).not.toContain("__");
      expect(manifest.programs[task.program]).toBeDefined();
      expect(Number.isInteger(task.every_minutes)).toBe(true);
      expect(task.every_minutes).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(task.timeout_minutes)).toBe(true);
    }
  });
});
