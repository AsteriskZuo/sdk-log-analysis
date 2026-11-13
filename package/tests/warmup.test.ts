import { describe, expect, it, jest } from "@jest/globals";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWarmup, type WarmupDeps } from "../packages/warmup.js";
import type { GitRunResult, GitRunner } from "../packages/worktree.js";

const REPO_URL = "https://github.com/easemob/emclient-linux";
const SLUG = "github.com-easemob-emclient-linux";

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

/** 建测试目录：cacheDir（业务缓存根）；warm = 预建 bare 缓存目录（热仓） */
async function makeDirs(opts: { warm?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "warmup-test-"));
  const cacheDir = join(root, "cache");
  const repoDir = join(cacheDir, "repos", SLUG);
  if (opts.warm) {
    await mkdir(repoDir, { recursive: true });
  }
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
    config: () => ({ sdk_repo_url: REPO_URL }),
    trySecret: () => undefined,
    cacheDir: () => cacheDir,
    log: (level, message, fields) => {
      logs.push({ level, message, ...(fields ? { fields } : {}) });
    },
    ...overrides,
  };
  return { deps, logs };
}

describe("runWarmup（spec §4.8/D10：平台定时任务——仓预热）", () => {
  it("冷仓：锁内 clone --bare 到 .tmp-{pid} 临时目录，rename 转正，机会性 prune，锁释放", async () => {
    const { cacheDir, repoDir } = await makeDirs();
    const { git, calls } = fakeGit([
      cloneOk, // clone --bare
      ok(""), // worktree prune（机会操作）
    ]);
    const { deps } = makeDeps(cacheDir, { git });

    const result = await runWarmup(deps);

    expect(result.repo).toBe(REPO_URL);
    expect(result.repo_dir).toBe(repoDir);
    expect(result.action).toBe("cloned");
    expect(typeof result.duration_ms).toBe("number");
    expect(result.metrics.warmup_action).toBe("cloned");
    expect(result.metrics.warmup_duration_ms).toBe(result.duration_ms);
    // clone 命令拼装：--bare + 原样 URL + 临时目录（.tmp-{pid} 后缀）
    expect(calls[0]).toEqual([
      "clone",
      "--bare",
      REPO_URL,
      `${repoDir}.tmp-${process.pid}`,
    ]);
    expect(calls[1]).toEqual(["-C", repoDir, "worktree", "prune"]);
    // rename 转正：正式目录存在、锁已释放；无任何 fetch
    expect(existsSync(repoDir)).toBe(true);
    expect(existsSync(join(cacheDir, "repos", ".lock"))).toBe(false);
    expect(calls.some((args) => args.includes("fetch"))).toBe(false);
  });

  it("热仓：锁内 fetch --no-tags origin（不 clone、不带 --tags），机会性 prune", async () => {
    const { cacheDir, repoDir } = await makeDirs({ warm: true });
    const { git, calls } = fakeGit([
      ok(""), // fetch --no-tags origin（锁内）
      ok(""), // worktree prune
    ]);
    const { deps } = makeDeps(cacheDir, { git });

    const result = await runWarmup(deps);

    expect(result.action).toBe("fetched");
    expect(result.metrics.warmup_action).toBe("fetched");
    expect(calls[0]).toEqual(["-C", repoDir, "fetch", "--no-tags", "origin"]);
    expect(calls[1]).toEqual(["-C", repoDir, "worktree", "prune"]);
    expect(calls.some((args) => args.includes("clone"))).toBe(false);
    expect(calls.some((args) => args.includes("--tags"))).toBe(false);
    expect(existsSync(join(cacheDir, "repos", ".lock"))).toBe(false);
  });

  it("凭据齐备 → clone/fetch 带 http.extraHeader（不进 URL）；缺一 → warn + 无注入", async () => {
    // 齐备：账号 + 一对 secrets
    const cold = await makeDirs();
    const { git, calls } = fakeGit([cloneOk, ok("")]);
    const { deps } = makeDeps(cold.cacheDir, {
      git,
      config: () => ({
        sdk_repo_url: REPO_URL,
        sdk_repo_account: "ci-bot",
      }),
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

    // 缺一（token 未注入）：warn 留痕 + 按无凭据 fetch（公开仓场景）
    const warm = await makeDirs({ warm: true });
    const plain = fakeGit([ok(""), ok("")]);
    const { deps: plainDeps, logs } = makeDeps(warm.cacheDir, {
      git: plain.git,
      config: () => ({
        sdk_repo_url: REPO_URL,
        sdk_repo_account: "ci-bot",
      }),
      trySecret: (name) =>
        name === "git_account_ci-bot_username" ? "bot-user" : undefined,
    });
    await runWarmup(plainDeps);
    expect(
      logs.some(
        (l) =>
          l.level === "warn" &&
          l.message === "git 账号凭据不完整，按无凭据继续（公开仓场景）" &&
          l.fields?.hasUsername === true &&
          l.fields?.hasToken === false,
      ),
    ).toBe(true);
    const fetchArgs = plain.calls[0];
    expect(fetchArgs.some((a) => a.includes("http.extraHeader"))).toBe(false);
  });

  it("缺 sdk_repo_url / 非 http(s) URL → 抛错（不执行 git）", async () => {
    const { cacheDir } = await makeDirs();
    const { git, calls } = fakeGit([]);
    await expect(
      runWarmup(makeDeps(cacheDir, { git, config: () => ({}) }).deps),
    ).rejects.toThrow(/sdk_repo_url/);
    await expect(
      runWarmup(
        makeDeps(cacheDir, {
          git,
          config: () => ({ sdk_repo_url: "/local/path" }),
        }).deps,
      ),
    ).rejects.toThrow(/http\(s\)/);
    expect(calls).toEqual([]);
  });

  it("冷克隆失败 → 清理临时目录 + 抛错（锁释放）", async () => {
    const { cacheDir, repoDir } = await makeDirs();
    const { git } = fakeGit([() => fail("fatal: auth failed")]);
    await expect(runWarmup(makeDeps(cacheDir, { git }).deps)).rejects.toThrow(
      /克隆源码仓失败.*auth failed/,
    );
    expect(existsSync(repoDir)).toBe(false);
    expect(existsSync(join(cacheDir, "repos", ".lock"))).toBe(false);
  });

  it("fetch 失败 → 抛错；stderr 含凭据时错误信息脱敏", async () => {
    const { cacheDir } = await makeDirs({ warm: true });
    const basic = Buffer.from("bot-user:secret-token").toString("base64");
    const { git } = fakeGit([
      () => fail(`fatal: auth failed for secret-token / bot-user / ${basic}`),
    ]);
    const { deps } = makeDeps(cacheDir, {
      git,
      config: () => ({
        sdk_repo_url: REPO_URL,
        sdk_repo_account: "ci-bot",
      }),
      trySecret: (name) =>
        name === "git_account_ci-bot_username"
          ? "bot-user"
          : name === "git_account_ci-bot_token"
            ? "secret-token"
            : undefined,
    });

    let thrown: Error | undefined;
    try {
      await runWarmup(deps);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("预热 fetch失败");
    expect(thrown!.message).not.toContain("secret-token");
    expect(thrown!.message).not.toContain("bot-user");
    expect(thrown!.message).not.toContain(basic);
    expect(thrown!.message).toContain("[REDACTED]");
  });

  it("锁被并发持有（新鲜锁）→ 抛「仓缓存锁被占用」，不执行 git", async () => {
    const { cacheDir } = await makeDirs();
    await mkdir(join(cacheDir, "repos", ".lock"), { recursive: true });
    const { git, calls } = fakeGit([]);
    await expect(runWarmup(makeDeps(cacheDir, { git }).deps)).rejects.toThrow(
      /仓缓存锁被占用/,
    );
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
