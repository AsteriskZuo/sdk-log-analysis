import { describe, expect, it, jest } from "@jest/globals";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitIsAncestor,
  gitShowMetadata,
  gitVerifySha,
  prepareWorktree,
  repoCacheDir,
  repoSlug,
  resolveGitCredentials,
  withRepoLock,
  type GitRunResult,
  type GitRunner,
} from "../packages/worktree.js";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

const REPO_URL = "https://github.com/easemob/emclient-linux";
const SLUG = "github.com-easemob-emclient-linux";

type Answer = GitRunResult | ((args: string[]) => GitRunResult);

/** 可编程 fake git：按调用序消费应答（函数形应答可做副作用，如 clone 真建临时目录）；
 *  calls 记录全部参数表供断言 */
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

/** 建测试目录：cacheDir（业务缓存根）+ workspace；warm = 预建 bare 缓存目录（暖仓） */
async function makeDirs(opts: { warm?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "worktree-test-"));
  const cacheDir = join(root, "cache");
  const workspace = join(root, "run-workspace");
  await mkdir(workspace, { recursive: true });
  const repoDir = join(cacheDir, "repos", SLUG);
  if (opts.warm) {
    await mkdir(repoDir, { recursive: true });
  }
  return { root, cacheDir, workspace, repoDir };
}

describe("repoSlug / repoCacheDir（URL → 缓存目录归一化）", () => {
  it("http(s) URL：剥协议、/ 转 -", () => {
    expect(repoSlug(REPO_URL)).toBe(SLUG);
    expect(repoSlug("http://gitlab.example.com/group/sub/repo")).toBe(
      "gitlab.example.com-group-sub-repo",
    );
  });

  it("尾部 .git 与尾部斜杠剥除", () => {
    expect(repoSlug(`${REPO_URL}.git`)).toBe(SLUG);
    expect(repoSlug(`${REPO_URL}/`)).toBe(SLUG);
    expect(repoSlug(`${REPO_URL}.git/`)).toBe(SLUG);
  });

  it("git@host:path（scp 形）先转标准形再归一化", () => {
    expect(repoSlug("git@github.com:easemob/emclient-linux.git")).toBe(SLUG);
  });

  it("非法 URL（空串/只剩协议）→ 抛错", () => {
    expect(() => repoSlug("")).toThrow(/非法 git 仓 URL/);
    expect(() => repoSlug("https://")).toThrow(/非法 git 仓 URL/);
  });

  it("repoCacheDir = {cacheDir}/repos/{slug}", () => {
    expect(repoCacheDir("/c", REPO_URL)).toBe(`/c/repos/${SLUG}`);
  });
});

describe("resolveGitCredentials（凭据组装纯函数）", () => {
  it("account/username/token 三值齐备 → 返回凭据对象", () => {
    expect(
      resolveGitCredentials({
        account: "ci-bot",
        username: "bot-user",
        token: "tok",
      }),
    ).toEqual({ username: "bot-user", token: "tok" });
  });

  it("缺任一值 → undefined（缺一 = 未配置，按无凭据继续）", () => {
    expect(
      resolveGitCredentials({ username: "bot-user", token: "tok" }),
    ).toBeUndefined();
    expect(
      resolveGitCredentials({ account: "ci-bot", token: "tok" }),
    ).toBeUndefined();
    expect(
      resolveGitCredentials({ account: "ci-bot", username: "bot-user" }),
    ).toBeUndefined();
    expect(resolveGitCredentials({})).toBeUndefined();
  });
});

describe("withRepoLock（mkdir 原子锁；预热脚本共用的同一把锁）", () => {
  it("正常获取/释放：fn 期间锁目录存在，返回后已释放", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-lock-"));
    const lockPath = join(root, "repos", ".lock");
    let lockedDuring = false;
    const result = await withRepoLock(root, () => {
      lockedDuring = existsSync(lockPath);
      return 42;
    });
    expect(result).toBe(42);
    expect(lockedDuring).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("fn 抛错 → 锁仍释放，错误原样上抛", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-lock-"));
    await expect(
      withRepoLock(root, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(join(root, "repos", ".lock"))).toBe(false);
  });

  it("新鲜锁（并发持有中）→ 抛「仓缓存锁被占用」", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-lock-"));
    await mkdir(join(root, "repos", ".lock"), { recursive: true });
    await expect(withRepoLock(root, () => 1)).rejects.toThrow(/仓缓存锁被占用/);
    // 不收割新鲜锁：锁目录原样保留
    expect(existsSync(join(root, "repos", ".lock"))).toBe(true);
  });

  it("残留锁（mtime 超 10 分钟）→ 收割后正常获取", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-lock-"));
    const lockPath = join(root, "repos", ".lock");
    await mkdir(lockPath, { recursive: true });
    const stale = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(lockPath, stale, stale);
    const result = await withRepoLock(root, () => "harvested");
    expect(result).toBe("harvested");
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("prepareWorktree（spec §6.6：远端 URL + bare 缓存 + 锁协议）", () => {
  it("冷仓：锁内 clone --bare 到 .tmp-{pid} 临时目录，成功后 rename 转正，锁释放", async () => {
    const { cacheDir, workspace, repoDir } = await makeDirs();
    const { git, calls } = fakeGit([
      (args) => {
        // clone 副作用：真建临时目录（renameSync 的对象）
        mkdirSync(args[args.length - 1], { recursive: true });
        return ok("");
      },
      ok(SHA), // rev-parse --verify ref^{commit}
      ok(""), // worktree prune（机会操作）
      ok(""), // worktree add --detach
      ok(SHA), // -C sourceDir rev-parse HEAD
    ]);

    const result = await prepareWorktree({
      repoUrl: REPO_URL,
      cacheDir,
      workspace,
      ref: "SDK_4.19.1",
      git,
    });

    expect(result).toEqual({
      sourceDir: join(workspace, "source"),
      commitSha: SHA,
      reused: false,
      fetched: false,
    });
    // clone 命令拼装：--bare + 原样 URL + 临时目录（.tmp-{pid} 后缀）
    expect(calls[0][0]).toBe("clone");
    expect(calls[0]).toContain("--bare");
    expect(calls[0]).toContain(REPO_URL);
    const tmpDir = calls[0][calls[0].length - 1];
    expect(tmpDir).toMatch(
      new RegExp(`^${repoDir.replace(/[/.]/g, "\\$&")}\\.tmp-\\d+$`),
    );
    // rename 转正：正式目录存在、临时目录已不存在、锁已释放
    expect(existsSync(repoDir)).toBe(true);
    expect(existsSync(tmpDir)).toBe(false);
    expect(existsSync(join(cacheDir, "repos", ".lock"))).toBe(false);
  });

  it("冷仓克隆失败 → 清理临时目录 + 抛错（ref + 脱敏摘要）", async () => {
    const { cacheDir, workspace, repoDir } = await makeDirs();
    let tmpSeen = "";
    const { git } = fakeGit([
      (args) => {
        tmpSeen = args[args.length - 1];
        return fail("fatal: auth failed");
      },
    ]);

    await expect(
      prepareWorktree({
        repoUrl: REPO_URL,
        cacheDir,
        workspace,
        ref: "msync",
        git,
      }),
    ).rejects.toThrow(/克隆源码仓失败（ref=msync）.*auth failed/);
    expect(existsSync(repoDir)).toBe(false);
    expect(existsSync(join(cacheDir, "repos", ".lock"))).toBe(false);
    expect(tmpSeen).toContain(".tmp-");
  });

  it("冷仓 + 残留锁（mtime 超 10 分钟）→ 收割后照常克隆", async () => {
    const { cacheDir, workspace, repoDir } = await makeDirs();
    const lockPath = join(cacheDir, "repos", ".lock");
    await mkdir(lockPath, { recursive: true });
    const stale = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(lockPath, stale, stale);
    const { git } = fakeGit([
      (args) => {
        mkdirSync(args[args.length - 1], { recursive: true });
        return ok("");
      },
      ok(SHA),
      ok(""),
      ok(""),
      ok(SHA),
    ]);

    const result = await prepareWorktree({
      repoUrl: REPO_URL,
      cacheDir,
      workspace,
      ref: "msync",
      git,
    });
    expect(result.commitSha).toBe(SHA);
    expect(existsSync(repoDir)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("冷仓 + 新鲜锁（并发持有中）→ 抛「仓缓存锁被占用」，不执行 git", async () => {
    const { cacheDir, workspace } = await makeDirs();
    await mkdir(join(cacheDir, "repos", ".lock"), { recursive: true });
    const { git, calls } = fakeGit([]);
    await expect(
      prepareWorktree({
        repoUrl: REPO_URL,
        cacheDir,
        workspace,
        ref: "msync",
        git,
      }),
    ).rejects.toThrow(/仓缓存锁被占用/);
    expect(calls).toEqual([]);
  });

  it("暖仓 + ref 本地解析命中 → 不 clone 不 fetch；prune 后 add --detach 命令拼装", async () => {
    const { cacheDir, workspace, repoDir } = await makeDirs({ warm: true });
    const { git, calls } = fakeGit([
      ok(SHA), // rev-parse --verify ref^{commit}
      ok(""), // worktree prune（机会操作）
      ok(""), // worktree add --detach
      ok(SHA), // -C sourceDir rev-parse HEAD
    ]);

    const result = await prepareWorktree({
      repoUrl: REPO_URL,
      cacheDir,
      workspace,
      ref: "SDK_4.19.1",
      git,
    });

    expect(result).toEqual({
      sourceDir: join(workspace, "source"),
      commitSha: SHA,
      reused: false,
      fetched: false,
    });
    expect(calls[0]).toEqual([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      "SDK_4.19.1^{commit}",
    ]);
    expect(calls[1]).toEqual(["-C", repoDir, "worktree", "prune"]);
    expect(calls[2]).toEqual([
      "-C",
      repoDir,
      "worktree",
      "add",
      "--detach",
      join(workspace, "source"),
      "SDK_4.19.1",
    ]);
    expect(calls.some((args) => args.includes("fetch"))).toBe(false);
    expect(calls.some((args) => args.includes("clone"))).toBe(false);
  });

  it("阶梯 b：本地解析不到 → 锁内 fetch --no-tags origin 后命中（fetched=true，锁已释放）", async () => {
    const { cacheDir, workspace, repoDir } = await makeDirs({ warm: true });
    const { git, calls } = fakeGit([
      fail("unknown revision"), // 首次 verify 失败
      ok(""), // fetch --no-tags origin（锁内）
      ok(SHA), // 二次 verify 命中
      ok(""), // prune
      ok(""), // add
      ok(SHA), // HEAD
    ]);

    const result = await prepareWorktree({
      repoUrl: REPO_URL,
      cacheDir,
      workspace,
      ref: "msync",
      git,
    });

    expect(result.fetched).toBe(true);
    expect(calls[1]).toEqual(["-C", repoDir, "fetch", "--no-tags", "origin"]);
    // 禁止全量标签同步：任何 fetch 都不带 --tags
    expect(
      calls
        .filter((args) => args.includes("fetch"))
        .every((args) => !args.includes("--tags")),
    ).toBe(true);
    expect(existsSync(join(cacheDir, "repos", ".lock"))).toBe(false);
  });

  it("阶梯 c：裸版本号 ref 解析不到 → 归一化 SDK_{ref} 重试「本地 + fetch」一次后命中", async () => {
    const { cacheDir, workspace } = await makeDirs({ warm: true });
    const { git, calls } = fakeGit([
      fail("unknown"), // verify 5.1.0
      ok(""), // fetch origin
      fail("unknown"), // 再 verify 5.1.0
      fail("unknown"), // verify SDK_5.1.0（本地）
      ok(""), // fetch origin（重试）
      ok(SHA), // verify SDK_5.1.0 命中
      ok(""), // prune
      ok(""), // add（checkoutRef = SDK_5.1.0）
      ok(SHA), // HEAD
    ]);

    const result = await prepareWorktree({
      repoUrl: REPO_URL,
      cacheDir,
      workspace,
      ref: "5.1.0",
      git,
    });

    expect(result.commitSha).toBe(SHA);
    const verifies = calls.filter((args) => args.includes("rev-parse"));
    expect(verifies[0][4]).toBe("5.1.0^{commit}");
    expect(verifies[2][4]).toBe("SDK_5.1.0^{commit}");
    // add 用归一化后的 ref（不是裸版本号）
    const add = calls.find((args) => args.includes("add"))!;
    expect(add[add.length - 1]).toBe("SDK_5.1.0");
  });

  it("阶梯 d：仍解析不到 → 锁内单独 fetch 精确 ref，用校验过的 FETCH_HEAD 检出", async () => {
    const { cacheDir, workspace, repoDir } = await makeDirs({ warm: true });
    const { git, calls } = fakeGit([
      fail("unknown"), // 首次 verify
      ok(""), // fetch --no-tags origin
      fail("unknown"), // 二次 verify 仍失败
      ok(""), // fetch --no-tags origin <ref>（精确 ref，锁内）
      ok(SHA2), // FETCH_HEAD verify
      ok(""), // prune
      ok(""), // worktree add（checkoutRef = FETCH_HEAD sha）
      ok(SHA2), // HEAD
    ]);

    const result = await prepareWorktree({
      repoUrl: REPO_URL,
      cacheDir,
      workspace,
      ref: "feature/fix-1",
      git,
    });

    expect(result.commitSha).toBe(SHA2);
    expect(result.fetched).toBe(true);
    expect(calls[3]).toEqual([
      "-C",
      repoDir,
      "fetch",
      "--no-tags",
      "origin",
      "feature/fix-1",
    ]);
    expect(calls[4]).toEqual([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      "FETCH_HEAD^{commit}",
    ]);
    // worktree add 用校验过的 sha（不是原始 ref）
    const add = calls.find((args) => args.includes("add"))!;
    expect(add[add.length - 1]).toBe(SHA2);
  });

  it("origin/ 限定 ref（origin/msync）精确 fetch 时剥掉 origin 前缀", async () => {
    const { cacheDir, workspace } = await makeDirs({ warm: true });
    const { git, calls } = fakeGit([
      fail("unknown"),
      ok(""),
      fail("unknown"),
      ok(""),
      ok(SHA2),
      ok(""),
      ok(""),
      ok(SHA2),
    ]);

    await prepareWorktree({
      repoUrl: REPO_URL,
      cacheDir,
      workspace,
      ref: "origin/msync",
      git,
    });

    expect(calls[3]).toEqual([
      "-C",
      join(cacheDir, "repos", SLUG),
      "fetch",
      "--no-tags",
      "origin",
      "msync",
    ]);
  });

  it("阶梯 e：ref 彻底解析不到 → 抛「无法解析 git ref」（带 ref 与脱敏 fetch 摘要），不执行 add", async () => {
    const { cacheDir, workspace } = await makeDirs({ warm: true });
    const { git, calls } = fakeGit([
      fail("unknown"),
      ok(""),
      fail("unknown"),
      fail("couldn't find remote ref"), // 精确 fetch 也失败
      // FETCH_HEAD verify 不执行（精确 fetch 失败）——队列留空即可
    ]);

    await expect(
      prepareWorktree({
        repoUrl: REPO_URL,
        cacheDir,
        workspace,
        ref: "no-such-ref",
        git,
      }),
    ).rejects.toThrow(/无法解析 git ref.*no-such-ref/);
    expect(calls.some((args) => args.includes("worktree"))).toBe(false);
  });

  it("worktree add 失败 → 抛错（ref + git 错误摘要）", async () => {
    const { cacheDir, workspace } = await makeDirs({ warm: true });
    const { git } = fakeGit([
      ok(SHA),
      ok(""), // prune
      fail("fatal: invalid reference"),
    ]);

    await expect(
      prepareWorktree({
        repoUrl: REPO_URL,
        cacheDir,
        workspace,
        ref: "SDK_4.19.1",
        git,
      }),
    ).rejects.toThrow(
      /worktree add失败（ref=SDK_4\.19\.1）.*invalid reference/,
    );
  });

  it("source 目录已存在 → 幂等复用（只读 HEAD，不 clone 不 fetch 不 add）", async () => {
    const { cacheDir, workspace } = await makeDirs();
    await mkdir(join(workspace, "source"), { recursive: true });
    const { git, calls } = fakeGit([ok(SHA)]);

    const result = await prepareWorktree({
      repoUrl: REPO_URL,
      cacheDir,
      workspace,
      ref: "msync",
      git,
    });

    expect(result).toEqual({
      sourceDir: join(workspace, "source"),
      commitSha: SHA,
      reused: true,
      fetched: false,
    });
    expect(calls).toEqual([
      ["-C", join(workspace, "source"), "rev-parse", "HEAD"],
    ]);
  });

  it("非法 ref / 逃逸子目录 → 直接抛错（不执行任何 git）", async () => {
    const { cacheDir, workspace } = await makeDirs();
    const { git, calls } = fakeGit([]);

    await expect(
      prepareWorktree({
        repoUrl: REPO_URL,
        cacheDir,
        workspace,
        ref: "bad;rm -rf",
        git,
      }),
    ).rejects.toThrow(/非法 git ref/);
    await expect(
      prepareWorktree({
        repoUrl: REPO_URL,
        cacheDir,
        workspace,
        ref: "msync",
        sourceSubdir: "../escape",
        git,
      }),
    ).rejects.toThrow(/非法 worktree 子目录/);
    expect(calls).toEqual([]);
  });

  it("凭据注入：齐备 → clone/fetch 带 http.extraHeader；缺省 → 无注入（匿名）", async () => {
    const { cacheDir, workspace, repoDir } = await makeDirs();
    const { git, calls } = fakeGit([
      (args) => {
        mkdirSync(args[args.length - 1], { recursive: true });
        return ok("");
      },
      fail("unknown"), // verify 失败 → 触发 fetch
      ok(""), // fetch origin
      ok(SHA),
      ok(""),
      ok(""),
      ok(SHA),
    ]);

    await prepareWorktree({
      repoUrl: REPO_URL,
      cacheDir,
      workspace,
      ref: "msync",
      credentials: { username: "bot-user", token: "secret-token" },
      git,
    });

    const expectedBasic = Buffer.from("bot-user:secret-token").toString(
      "base64",
    );
    const headerArgs = [
      "-c",
      `http.extraHeader=Authorization: Basic ${expectedBasic}`,
    ];
    // clone：extraHeader 在最前（无 -C）
    expect(calls[0].slice(0, 2)).toEqual(headerArgs);
    // fetch：-C 缓存仓 + extraHeader
    const fetchArgs = calls.find((args) => args.includes("fetch"))!;
    expect(fetchArgs).toEqual([
      "-C",
      repoDir,
      ...headerArgs,
      "fetch",
      "--no-tags",
      "origin",
    ]);

    // 缺省凭据：clone/fetch 原样发出（匿名，公开仓场景）
    const plainDirs = await makeDirs();
    const plain = fakeGit([
      (args) => {
        mkdirSync(args[args.length - 1], { recursive: true });
        return ok("");
      },
      ok(SHA),
      ok(""),
      ok(""),
      ok(SHA),
    ]);
    await prepareWorktree({
      repoUrl: REPO_URL,
      cacheDir: plainDirs.cacheDir,
      workspace: plainDirs.workspace,
      ref: "msync",
      git: plain.git,
    });
    expect(plain.calls[0]).toEqual([
      "clone",
      "--bare",
      REPO_URL,
      `${plainDirs.repoDir}.tmp-${process.pid}`,
    ]);
  });

  it("凭据绝不进错误信息：git stderr 含 username/token/base64 时错误信息脱敏", async () => {
    const { cacheDir, workspace } = await makeDirs();
    const basic = Buffer.from("bot-user:secret-token").toString("base64");
    const { git } = fakeGit([
      () => fail(`fatal: auth failed for secret-token / bot-user / ${basic}`),
    ]);

    let thrown: Error | undefined;
    try {
      await prepareWorktree({
        repoUrl: REPO_URL,
        cacheDir,
        workspace,
        ref: "msync",
        credentials: { username: "bot-user", token: "secret-token" },
        git,
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).not.toContain("secret-token");
    expect(thrown!.message).not.toContain("bot-user");
    expect(thrown!.message).not.toContain(basic);
    expect(thrown!.message).toContain("[REDACTED]");
  });
});

describe("git 验证助手（mainline 审计用）", () => {
  it("gitVerifySha：非 hex 输入直接 undefined（不执行 git）", async () => {
    const { git, calls } = fakeGit([]);
    await expect(
      gitVerifySha(git, "/repo", "not-a-sha"),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("gitVerifySha：合法 sha 经 rev-parse --verify 规范化", async () => {
    const { git, calls } = fakeGit([ok(SHA)]);
    await expect(gitVerifySha(git, "/repo", SHA.slice(0, 7))).resolves.toBe(
      SHA,
    );
    expect(calls[0]).toEqual([
      "-C",
      "/repo",
      "rev-parse",
      "--verify",
      `${SHA.slice(0, 7)}^{commit}`,
    ]);
  });

  it("gitIsAncestor：merge-base --is-ancestor 退出码即结论", async () => {
    const yes = fakeGit([ok("")]);
    await expect(gitIsAncestor(yes.git, "/repo", SHA, "HEAD")).resolves.toBe(
      true,
    );
    const no = fakeGit([fail("")]);
    await expect(gitIsAncestor(no.git, "/repo", SHA, "HEAD")).resolves.toBe(
      false,
    );
  });

  it("gitShowMetadata：NUL 分隔四字段解析；字段缺失 → undefined", async () => {
    const { git } = fakeGit([
      ok(`${SHA}\x00fix subject\x00author\x002026-11-12T10:00:00+08:00`),
    ]);
    await expect(gitShowMetadata(git, "/repo", SHA)).resolves.toEqual({
      sha: SHA,
      subject: "fix subject",
      author: "author",
      date: "2026-11-12T10:00:00+08:00",
    });

    const broken = fakeGit([ok(`${SHA}\x00\x00\x00`)]);
    await expect(
      gitShowMetadata(broken.git, "/repo", SHA),
    ).resolves.toBeUndefined();
  });
});
