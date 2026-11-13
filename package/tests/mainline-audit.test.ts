import { describe, expect, it, jest } from "@jest/globals";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAuditPrompt,
  parseAuditOutput,
  runMainlineAudit,
} from "../packages/mainline-audit.js";
import type { AnalysisReport } from "../packages/report-parse.js";
import type { GitRunResult, GitRunner } from "../packages/worktree.js";

const HEAD_SHA = "c".repeat(40);
const FIX_SHA = "d".repeat(40);

const REPO_URL = "https://github.com/easemob/emclient-linux";
const SLUG = "github.com-easemob-emclient-linux";

const REPORT: AnalysisReport = {
  issue_key: "HIM-1",
  root_cause: "重连时序竞争",
  summary: "摘要",
  confidence: "high",
  evidence: [],
  affected_modules: [],
};

const ok = (stdout = ""): GitRunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): GitRunResult => ({
  code: 1,
  stdout: "",
  stderr,
});

function fakeGit(answers: GitRunResult[]): {
  git: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const queue = [...answers];
  const git = jest.fn(async (args: string[]) => {
    calls.push(args);
    const next = queue.shift();
    if (!next) {
      throw new Error(`fake git 应答耗尽：${args.join(" ")}`);
    }
    return next;
  }) as unknown as GitRunner;
  return { git, calls };
}

/** 建测试目录：cacheDir（含预建暖仓 bare 缓存）+ workspace */
async function makeDirs(): Promise<{
  cacheDir: string;
  workspace: string;
  repoDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mainline-audit-"));
  const cacheDir = join(root, "cache");
  const workspace = join(root, "run-workspace");
  const repoDir = join(cacheDir, "repos", SLUG);
  await mkdir(repoDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { cacheDir, workspace, repoDir };
}

/** worktree 准备成功的四段 git 应答（verify → prune → add → HEAD） */
const worktreeOk: GitRunResult[] = [ok(HEAD_SHA), ok(""), ok(""), ok(HEAD_SHA)];

const silentLog = jest.fn(() => undefined);

describe("parseAuditOutput（spec §6.9 审计契约）", () => {
  it("直接 JSON / 围栏 JSON 均可解析", () => {
    const direct = parseAuditOutput(
      JSON.stringify({ status: "not-fixed", summary: "未修复证据" }),
    );
    expect(direct).toEqual({ status: "not-fixed", summary: "未修复证据" });

    const fenced = parseAuditOutput(
      '结论：\n```json\n{"status":"already-fixed","summary":"已修复","fix_commit":"abc1234"}\n```',
    );
    expect(fenced).toEqual({
      status: "already-fixed",
      summary: "已修复",
      fix_commit: "abc1234",
    });
  });

  it("status 值域外 / summary 空 → undefined", () => {
    expect(
      parseAuditOutput(JSON.stringify({ status: "fixed", summary: "x" })),
    ).toBeUndefined();
    expect(
      parseAuditOutput(JSON.stringify({ status: "unknown", summary: "  " })),
    ).toBeUndefined();
    expect(parseAuditOutput("没有 JSON")).toBeUndefined();
  });
});

describe("runMainlineAudit（降级语义：永不抛错，异常 → unknown）", () => {
  it("already-fixed + SHA 祖先校验通过 → 采纳并用 git show 规范元数据替换模型自述", async () => {
    const { cacheDir, workspace } = await makeDirs();
    const { git, calls } = fakeGit([
      ...worktreeOk,
      ok(FIX_SHA), // rev-parse --verify 短 sha 规范化
      ok(""), // merge-base --is-ancestor（code 0 = 是祖先）
      ok(
        `${FIX_SHA}\x00fix: race on reconnect\x00dev\x002026-11-10T08:00:00+08:00`,
      ), // git show
    ]);
    const agentCall = jest.fn(async (_input: string) =>
      JSON.stringify({
        status: "already-fixed",
        summary: "主线已修复",
        fix_commit: FIX_SHA.slice(0, 7),
      }),
    );

    const result = await runMainlineAudit({
      workspace,
      sdkRepoUrl: REPO_URL,
      cacheDir,
      mainlineRef: "msync",
      issueKey: "HIM-1",
      report: REPORT,
      agentCall,
      git,
      log: silentLog,
    });

    // 模型自述的短 sha 被 git show 的完整 sha 替换
    expect(result).toEqual({
      status: "already-fixed",
      summary: "主线已修复",
      fix_commit: FIX_SHA,
    });
    // 祖先校验针对审计 worktree（{workspace}/mainline-audit/source）HEAD
    const auditSource = join(workspace, "mainline-audit", "source");
    expect(calls[5]).toEqual([
      "-C",
      auditSource,
      "merge-base",
      "--is-ancestor",
      FIX_SHA,
      HEAD_SHA,
    ]);
  });

  it("祖先校验不过 → 降级 unknown（绝不发布未经验证的 SHA）", async () => {
    const { cacheDir, workspace } = await makeDirs();
    const { git } = fakeGit([
      ...worktreeOk,
      ok(FIX_SHA), // verify 通过
      fail(""), // merge-base 非祖先（code != 0）
    ]);
    const warnLog = jest.fn(() => undefined);

    const result = await runMainlineAudit({
      workspace,
      sdkRepoUrl: REPO_URL,
      cacheDir,
      mainlineRef: "msync",
      issueKey: "HIM-1",
      report: REPORT,
      agentCall: async () =>
        JSON.stringify({
          status: "already-fixed",
          summary: "声称已修复",
          fix_commit: FIX_SHA,
        }),
      git,
      log: warnLog,
    });

    expect(result.status).toBe("unknown");
    expect(result.fix_commit).toBeUndefined();
    expect(warnLog).toHaveBeenCalledWith(
      "warn",
      "mainline 审计 fix_commit 未通过祖先校验，降级 unknown",
      expect.objectContaining({ issueKey: "HIM-1", fixCommit: FIX_SHA }),
    );
  });

  it("git show 元数据读取失败 → 降级 unknown", async () => {
    const { cacheDir, workspace } = await makeDirs();
    const { git } = fakeGit([
      ...worktreeOk,
      ok(FIX_SHA),
      ok(""),
      fail("fatal: bad object"), // git show 失败
    ]);

    const result = await runMainlineAudit({
      workspace,
      sdkRepoUrl: REPO_URL,
      cacheDir,
      mainlineRef: "msync",
      issueKey: "HIM-1",
      report: REPORT,
      agentCall: async () =>
        JSON.stringify({
          status: "already-fixed",
          summary: "x",
          fix_commit: FIX_SHA,
        }),
      git,
      log: silentLog,
    });

    expect(result).toEqual({
      status: "unknown",
      summary: "主线审计修复 commit 元数据校验失败",
    });
  });

  it("already-fixed 但未给 fix_commit → 降级 unknown", async () => {
    const { cacheDir, workspace } = await makeDirs();
    const { git } = fakeGit([...worktreeOk]);

    const result = await runMainlineAudit({
      workspace,
      sdkRepoUrl: REPO_URL,
      cacheDir,
      mainlineRef: "msync",
      issueKey: "HIM-1",
      report: REPORT,
      agentCall: async () =>
        JSON.stringify({ status: "already-fixed", summary: "没给 sha" }),
      git,
      log: silentLog,
    });

    expect(result.status).toBe("unknown");
  });

  it("not-fixed 直接采纳（不做 fix_commit 验证）", async () => {
    const { cacheDir, workspace } = await makeDirs();
    const { git, calls } = fakeGit([...worktreeOk]);

    const result = await runMainlineAudit({
      workspace,
      sdkRepoUrl: REPO_URL,
      cacheDir,
      mainlineRef: "msync",
      issueKey: "HIM-1",
      report: REPORT,
      agentCall: async () =>
        JSON.stringify({ status: "not-fixed", summary: "主线未修复" }),
      git,
      log: silentLog,
    });

    expect(result).toEqual({ status: "not-fixed", summary: "主线未修复" });
    // 只有 worktree 四次 git 调用（verify/prune/add/HEAD），无 merge-base/show
    expect(calls).toHaveLength(4);
  });

  it("agent 调用失败 → warn + unknown，不抛错（审计降级不拖垮主分析）", async () => {
    const { cacheDir, workspace } = await makeDirs();
    const { git } = fakeGit([...worktreeOk]);
    const warnLog = jest.fn(() => undefined);

    const result = await runMainlineAudit({
      workspace,
      sdkRepoUrl: REPO_URL,
      cacheDir,
      mainlineRef: "msync",
      issueKey: "HIM-1",
      report: REPORT,
      agentCall: async () => {
        throw new Error("全部模型审计失败");
      },
      git,
      log: warnLog,
    });

    expect(result).toEqual({
      status: "unknown",
      summary: "主线审计模型调用失败",
    });
    expect(warnLog).toHaveBeenCalledWith(
      "warn",
      "mainline 审计 agent 调用失败，降级 unknown",
      expect.objectContaining({ issueKey: "HIM-1" }),
    );
  });

  it("审计输出非法 → unknown", async () => {
    const { cacheDir, workspace } = await makeDirs();
    const { git } = fakeGit([...worktreeOk]);

    const result = await runMainlineAudit({
      workspace,
      sdkRepoUrl: REPO_URL,
      cacheDir,
      mainlineRef: "msync",
      issueKey: "HIM-1",
      report: REPORT,
      agentCall: async () => "一段没有 JSON 的话",
      git,
      log: silentLog,
    });

    expect(result).toEqual({
      status: "unknown",
      summary: "主线审计输出无法解析",
    });
  });

  it("worktree 准备失败 → unknown（不抛错）", async () => {
    const { cacheDir, workspace } = await makeDirs();
    const { git } = fakeGit([
      fail("unknown revision"), // 首次 verify 失败
      ok(""), // fetch origin
      fail("unknown revision"), // 二次 verify 仍失败
      fail("couldn't find remote ref"), // 精确 fetch 也失败
    ]);
    const agentCall = jest.fn(async (_input: string) => "{}");
    const warnLog = jest.fn(() => undefined);

    const result = await runMainlineAudit({
      workspace,
      sdkRepoUrl: REPO_URL,
      cacheDir,
      mainlineRef: "msync",
      issueKey: "HIM-1",
      report: REPORT,
      agentCall,
      git,
      log: warnLog,
    });

    expect(result).toEqual({
      status: "unknown",
      summary: "主线审计未能准备源码检出（worktree 失败）",
    });
    expect(agentCall).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledWith(
      "warn",
      "mainline 审计 worktree 准备失败，降级 unknown",
      expect.objectContaining({ issueKey: "HIM-1", mainlineRef: "msync" }),
    );
  });

  it("审计 worktree 落在 {workspace}/mainline-audit/source 并检出 mainline_ref", async () => {
    const { cacheDir, workspace, repoDir } = await makeDirs();
    const { git, calls } = fakeGit([...worktreeOk]);

    await runMainlineAudit({
      workspace,
      sdkRepoUrl: REPO_URL,
      cacheDir,
      mainlineRef: "msync",
      issueKey: "HIM-1",
      report: REPORT,
      agentCall: async () =>
        JSON.stringify({ status: "unknown", summary: "证据不足" }),
      git,
      log: silentLog,
    });

    expect(calls[2]).toEqual([
      "-C",
      repoDir,
      "worktree",
      "add",
      "--detach",
      join(workspace, "mainline-audit", "source"),
      "msync",
    ]);
  });
});

describe("buildAuditPrompt", () => {
  it("含工单 key、主线 ref、只读约束与报告 JSON", () => {
    const prompt = buildAuditPrompt({
      issueKey: "HIM-1",
      mainlineRef: "msync",
      report: REPORT,
    });
    expect(prompt).toContain("HIM-1");
    expect(prompt).toContain("msync");
    expect(prompt).toContain("mainline-audit/source");
    expect(prompt).toContain("只读");
    expect(prompt).toContain("重连时序竞争");
  });
});
