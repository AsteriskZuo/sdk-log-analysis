import { describe, expect, it, jest } from "@jest/globals";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAnalysisFlow,
  type AnalysisFlowDeps,
} from "../packages/analysis-flow.js";
import { AnalysisRecordStore } from "../packages/analysis-records.js";
import { PLATFORM_UNKNOWN_KEY } from "../packages/repo-select.js";
import type { RepoRegistry } from "../packages/repos.js";
import type { GitRunResult, GitRunner } from "../packages/worktree.js";

const UPDATED = "2026-11-12T10:00:00.000+0800";
const SHA = "a".repeat(40);

const REPO_URL = "https://github.com/easemob/emclient-linux";
const REPO_SLUG = "github.com-easemob-emclient-linux";
const IOS_URL = "https://github.com/easemob/emclient-ios";
const IOS_SLUG = "github.com-easemob-emclient-ios";

/** 默认登记表 fixture：单 linux 仓（默认工单标题/日志内容命中 emclient 关键词） */
const REGISTRY: RepoRegistry = {
  version: 1,
  repos: [
    {
      key: "linux",
      url: REPO_URL,
      mainline_ref: "msync",
      assignee_tag: "sdk",
      match: ["linux", "emclient"],
      notes: "C++ 核心仓",
    },
  ],
};

const PASS_CONTENT = [
  "**工单审查通过 ✅**",
  "",
  "> 工单：[HIM-1](https://j1.private.easemob.com/browse/HIM-1)",
  "> 分类：Bug",
  "> 审查时间：2026/11/12 15:30:00",
].join("\n");

function envelope(payload: unknown): unknown {
  return {
    contract_version: "v1",
    source: "internal",
    event_type: "b01M4QSEAC5MZA2N2RTNMEDDCX1.completed",
    session_id: "HIM-1",
    hop_count: 1,
    payload,
  };
}

const REPORT_JSON = JSON.stringify({
  issue_key: "HIM-1",
  root_cause: "重连时序竞争",
  summary: "报告摘要",
  confidence: "high",
  evidence: ["line1"],
  affected_modules: ["session.cpp"],
});

const AUDIT_JSON = JSON.stringify({
  status: "not-fixed",
  summary: "主线未修复",
});

function issue(overrides: Record<string, unknown> = {}) {
  return {
    key: "HIM-1",
    summary: "登录后重连丢会话",
    description: "见附件日志",
    status: "Open",
    statusCategory: "In Progress",
    issueType: "Bug",
    priority: "Major",
    updated: UPDATED,
    versions: ["4.19.1"],
    fixVersions: ["4.19.2"],
    ...overrides,
  };
}

function fetchOutput(overrides: {
  issue?: Record<string, unknown>;
  logs?: { file: string; size: number; source_attachment: string }[];
  identity?: Record<string, string>;
}) {
  return {
    status: "success",
    data: {
      issue: issue(overrides.issue ?? {}),
      logs: overrides.logs ?? [
        { file: "app.log", size: 10, source_attachment: "app.log" },
      ],
      skipped: [],
    },
    identity: overrides.identity ?? {
      assigneeEmail: "zhangsan@example.com",
      assigneeName: "zhangsan",
    },
  };
}

const gitOk = (stdout = ""): GitRunResult => ({ code: 0, stdout, stderr: "" });

/** 主 worktree + 审计 worktree 全部成功的 fake git（各 verify/prune/add/HEAD 四段，共 8 次调用） */
function fakeGitAllOk(): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const queue: GitRunResult[] = [
    gitOk(SHA), // 主 worktree verify
    gitOk(""), // worktree prune（机会操作）
    gitOk(""), // worktree add --detach
    gitOk(SHA), // HEAD
    gitOk(SHA), // 审计 worktree verify
    gitOk(""), // prune
    gitOk(""), // add
    gitOk(SHA), // HEAD
  ];
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

type DepsOverrides = Partial<AnalysisFlowDeps>;

async function makeDeps(
  overrides: DepsOverrides = {},
  opts: { warmSlugs?: string[] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "analysis-flow-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");
  // 预建暖仓 bare 缓存目录（{cacheDir}/repos/{slug}）：跳过首克隆，走本地解析路径
  for (const slug of [REPO_SLUG, ...(opts.warmSlugs ?? [])]) {
    await mkdir(join(cacheDir, "repos", slug), { recursive: true });
  }
  // 工具落盘模拟：input/logs/app.log（ref 选择会读 core version 行；材料化读同目录；
  // 内容含 emclient 关键词，选仓语料命中 linux 仓）
  await mkdir(join(workspace, "input", "logs"), { recursive: true });
  await writeFile(
    join(workspace, "input", "logs", "app.log"),
    "emclient init done\n",
    "utf8",
  );

  const store = new AnalysisRecordStore(dataDir);
  const { git, calls } = fakeGitAllOk();
  const agent = jest.fn(async (call: { input: unknown }) => {
    const input = typeof call.input === "string" ? call.input : "";
    return input.includes("主线修复审计") ? AUDIT_JSON : REPORT_JSON;
  });
  const deps: AnalysisFlowDeps = {
    run: jest.fn(async () => fetchOutput({})),
    agent,
    models: jest.fn(async () => ({
      default: "mock/mock-model",
      providers: [{ name: "mock", models: ["mock-model"] }],
    })),
    config: () => ({
      jira_url: "https://j1.private.easemob.com",
    }),
    loadRegistry: () => REGISTRY,
    secret: (name: string) => `secret-${name}`,
    log: () => undefined,
    workspace,
    cacheDir: () => cacheDir,
    store,
    lookupPersonTags: async () => ["sdk"],
    lookupWeComAccount: async () => ({
      wecomUserid: "ZhangSan",
      wecomName: "张三",
    }),
    git,
    ...overrides,
  };
  return { deps, store, workspace, cacheDir, gitCalls: calls, agent };
}

describe("输入过滤（§3.4 + §4.2）", () => {
  it("payload null → return(null)，不拉工单", async () => {
    const { deps } = await makeDeps();
    const outcome = await runAnalysisFlow(envelope(null), deps);
    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("非通过标题（审查不通过）→ return(null)", async () => {
    const { deps } = await makeDeps();
    const outcome = await runAnalysisFlow(
      envelope({
        content: "**工单审查不通过 ❌**\n> 工单：[HIM-1](x)",
        mentions: [],
      }),
      deps,
    );
    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("通过标题但解析不出工单 key → warn + return(null)", async () => {
    const log = jest.fn(() => undefined);
    const { deps } = await makeDeps({ log });
    const outcome = await runAnalysisFlow(
      envelope({ content: "**工单审查通过 ✅**\n没有链接行" }),
      deps,
    );
    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "warn",
      "审查通知解析失败：未找到工单 key，跳过分析",
      {},
    );
  });
});

describe("自持过滤（§4.3：F1/F2/F3）", () => {
  it("F1：终态工单 → 写记录 + return(null)，不调 agent", async () => {
    const { deps, store } = await makeDeps({
      run: jest.fn(async () =>
        fetchOutput({
          issue: { status: "Complete", statusCategory: "Complete" },
        }),
      ),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.agent).not.toHaveBeenCalled();
    const record = await store.get("HIM-1");
    expect(record?.last_analyzed_updated).toBe(UPDATED);
  });

  it("F2：非 Bug 工单 → 写记录 + return(null)", async () => {
    const log = jest.fn(() => undefined);
    const { deps, store } = await makeDeps({
      run: jest.fn(async () =>
        fetchOutput({ issue: { issueType: "New Feature" } }),
      ),
      log,
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.agent).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("info", "F2 非 Bug 工单，跳过分析", {
      issueKey: "HIM-1",
      issueType: "New Feature",
    });
    expect((await store.get("HIM-1"))?.last_analyzed_updated).toBe(UPDATED);
  });

  it("F3：负责人有记录但 tags 不含 sdk → 写记录 + return(null)", async () => {
    const { deps, store } = await makeDeps({
      lookupPersonTags: async () => ["backend"],
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.agent).not.toHaveBeenCalled();
    expect((await store.get("HIM-1"))?.last_analyzed_updated).toBe(UPDATED);
  });

  it("F3：负责人查不到映射记录（tags=[]）→ 视为无标签跳过（v2 语义）", async () => {
    const log = jest.fn(() => undefined);
    const { deps } = await makeDeps({
      lookupPersonTags: async () => [],
      log,
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(log).toHaveBeenCalledWith(
      "info",
      "F3 负责人无订阅标签，跳过分析",
      expect.objectContaining({
        issueKey: "HIM-1",
        assigneeTag: "sdk",
        hasAssignee: true,
      }),
    );
  });

  it("F3：identity 无 assignee → 视为无标签跳过（不查映射表）", async () => {
    const lookupPersonTags = jest.fn(async () => ["sdk"]);
    const { deps } = await makeDeps({
      run: jest.fn(async () => fetchOutput({ identity: {} })),
      lookupPersonTags,
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(lookupPersonTags).not.toHaveBeenCalled();
    expect(deps.agent).not.toHaveBeenCalled();
  });

  it("F3：assignee_tag 取自命中登记表条目（非 sdk 标签同样生效）", async () => {
    const { deps } = await makeDeps({
      lookupPersonTags: async () => ["backend"],
      loadRegistry: () => ({
        version: 1,
        repos: [
          {
            key: "linux",
            url: REPO_URL,
            mainline_ref: "msync",
            assignee_tag: "backend",
            match: ["emclient"],
          },
        ],
      }),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    // 条目标签命中 → 不被 F3 拦截，走完全流程
    expect(outcome.type).toBe("return");
    expect(outcome.type === "return" && outcome.value !== null).toBe(true);
  });
});

describe("去重与无日志分支（§6 步骤 4/5）", () => {
  it("去重命中（updated 与记录相同）→ return(null)，不调 agent", async () => {
    const { deps, store } = await makeDeps();
    await store.markAnalyzed("HIM-1", UPDATED);

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.agent).not.toHaveBeenCalled();
  });

  it("updated 缺失 → 不去重（warn 留痕，照常分析）", async () => {
    const log = jest.fn(() => undefined);
    const { deps, store } = await makeDeps({
      run: jest.fn(async () => fetchOutput({ issue: { updated: undefined } })),
      log,
    });
    await store.markAnalyzed("HIM-1", "whatever");

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("return");
    expect(outcome.type === "return" && outcome.value !== null).toBe(true);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "实时工单缺 updated，本次不去重（每次都分析）",
      { issueKey: "HIM-1" },
    );
  });

  it("无日志分支：写记录（reason=no_logs）+ info 日志 + return(null)，不通知不失败", async () => {
    const log = jest.fn(() => undefined);
    const { deps, store } = await makeDeps({
      run: jest.fn(async () => fetchOutput({ logs: [] })),
      log,
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.agent).not.toHaveBeenCalled();
    expect((await store.get("HIM-1"))?.last_analyzed_updated).toBe(UPDATED);
    expect(log).toHaveBeenCalledWith("info", "无日志附件，跳过分析", {
      issueKey: "HIM-1",
      reason: "no_logs",
    });
  });
});

describe("失败路径", () => {
  it("工具 error 双态 → fail（code/message 原样透出）", async () => {
    const { deps } = await makeDeps({
      run: jest.fn(async () => ({
        status: "error",
        code: "ticket_not_found",
        message: "jira 工单不存在",
      })),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome).toEqual({
      type: "fail",
      reason: "拉取工单 HIM-1 失败：ticket_not_found jira 工单不存在",
    });
  });

  it("工具返回非法形状 → fail", async () => {
    const { deps } = await makeDeps({
      run: jest.fn(async () => "unexpected"),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("fail");
  });

  it("ref 歧义（多版本无法消歧）→ fail 且消息带候选列表", async () => {
    const { deps } = await makeDeps({
      run: jest.fn(async () =>
        fetchOutput({ issue: { versions: ["4.19.1", "4.20.0"] } }),
      ),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("fail");
    if (outcome.type === "fail") {
      expect(outcome.reason).toContain("4.19.1");
      expect(outcome.reason).toContain("4.20.0");
    }
    expect(deps.agent).not.toHaveBeenCalled();
  });

  /** 选中 ref 阶梯最终失败的 fake git 应答（verify 失败 → fetch → verify 失败 → 精确 fetch 失败） */
  const refResolveFail: () => GitRunResult[] = () => [
    { code: 1, stdout: "", stderr: "unknown revision" },
    gitOk(""),
    { code: 1, stdout: "", stderr: "unknown revision" },
    { code: 1, stdout: "", stderr: "couldn't find remote ref" },
  ];

  it("选中 ref 解析失败 → 回退 mainline_ref 成功继续（provenance 含回退说明与 branch-head）", async () => {
    const queue: GitRunResult[] = [
      ...refResolveFail(), // 选中 ref SDK_4.19.1 阶梯最终失败
      gitOk(SHA), // 回退 msync：verify 命中
      gitOk(""), // prune
      gitOk(""), // add
      gitOk(SHA), // HEAD
      gitOk(SHA), // 审计 worktree verify
      gitOk(""), // prune
      gitOk(""), // add
      gitOk(SHA), // HEAD
    ];
    const calls: string[][] = [];
    const git = jest.fn(async (args: string[]) => {
      calls.push(args);
      const next = queue.shift();
      if (!next) throw new Error("应答耗尽");
      return next;
    }) as unknown as GitRunner;
    const log = jest.fn(() => undefined);
    const { deps, workspace } = await makeDeps({ git, log });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    // 回退成功 → 走完全流程（产出非 null）
    expect(outcome.type).toBe("return");
    expect(outcome.type === "return" && outcome.value !== null).toBe(true);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "选中 ref 解析失败，回退主线重试",
      expect.objectContaining({
        issueKey: "HIM-1",
        ref: "SDK_4.19.1",
        mainlineRef: "msync",
      }),
    );
    // provenance 落盘：Selected ref 是主线，依据含回退说明与 branch-head 置信度
    const taskContext = await readFile(
      join(workspace, "task-context.md"),
      "utf8",
    );
    expect(taskContext).toContain("- Selected ref: `msync`");
    expect(taskContext).toContain("ref 'SDK_4.19.1' 未命中，回退主线 msync");
    expect(taskContext).toContain("branch-head");
  });

  it("回退主线也失败 → fail（带原 ref 与回退说明），不调 agent", async () => {
    const queue: GitRunResult[] = [
      ...refResolveFail(), // 选中 ref 失败
      ...refResolveFail(), // 回退主线也失败
    ];
    const git = jest.fn(async (_args: string[]) => {
      const next = queue.shift();
      if (!next) throw new Error("应答耗尽");
      return next;
    }) as unknown as GitRunner;
    const { deps } = await makeDeps({ git });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("fail");
    if (outcome.type === "fail") {
      expect(outcome.reason).toContain("SDK_4.19.1");
      expect(outcome.reason).toContain("回退主线 msync 仍失败");
    }
    expect(deps.agent).not.toHaveBeenCalled();
  });

  it("选中的本来就是 mainline_ref → 失败直接 fail（不自我重复，不重试）", async () => {
    const queue: GitRunResult[] = refResolveFail();
    const calls: string[][] = [];
    const git = jest.fn(async (args: string[]) => {
      calls.push(args);
      const next = queue.shift();
      if (!next) throw new Error("应答耗尽");
      return next;
    }) as unknown as GitRunner;
    const log = jest.fn(() => undefined);
    const { deps } = await makeDeps({ git, log });
    deps.loadRegistry = () => ({
      version: 1,
      repos: [
        {
          key: "linux",
          url: REPO_URL,
          mainline_ref: "SDK_4.19.1", // 与选中 ref 相同
          assignee_tag: "sdk",
          match: ["emclient"],
        },
      ],
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("fail");
    if (outcome.type === "fail") {
      expect(outcome.reason).toContain("worktree 准备失败（ref=SDK_4.19.1）");
      expect(outcome.reason).not.toContain("回退主线");
    }
    // 只尝试了一次（选中 ref 的阶梯四次调用），无回退重试
    expect(calls).toHaveLength(4);
    expect(log).not.toHaveBeenCalledWith(
      "warn",
      "选中 ref 解析失败，回退主线重试",
      expect.anything(),
    );
    expect(deps.agent).not.toHaveBeenCalled();
  });

  it("agent 输出非法（全部模型解析失败）→ fail（分析报告解析失败）", async () => {
    const { deps, store } = await makeDeps({
      agent: jest.fn(async () => "没有 JSON 的废话"),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("fail");
    if (outcome.type === "fail") {
      expect(outcome.reason).toContain("分析报告解析失败");
    }
    // 失败不写去重记录（下次事件重试）
    await expect(store.get("HIM-1")).resolves.toBeUndefined();
  });

  it("模型枚举为空（providers=[]）→ fail（业务未配置大模型配置），不调 agent", async () => {
    const agent = jest.fn(async () => REPORT_JSON);
    const { deps } = await makeDeps({
      agent,
      models: jest.fn(async () => ({ default: "", providers: [] })),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("fail");
    if (outcome.type === "fail") {
      expect(outcome.reason).toContain("业务未配置大模型配置");
    }
    expect(agent).not.toHaveBeenCalled();
  });

  it("模型枚举失败（models 抛错）→ fail（枚举大模型配置失败），不调 agent", async () => {
    const agent = jest.fn(async () => REPORT_JSON);
    const { deps } = await makeDeps({
      agent,
      models: jest.fn(async () => {
        throw new Error("models.json 损坏");
      }),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("fail");
    if (outcome.type === "fail") {
      expect(outcome.reason).toContain("枚举大模型配置失败");
      expect(outcome.reason).toContain("models.json 损坏");
    }
    expect(agent).not.toHaveBeenCalled();
  });

  it("兜底链：首个模型调用失败 → 按枚举顺序换下一个采纳（逐个 fresh 会话）", async () => {
    const agent = jest.fn(async (call: { input: unknown; model?: string }) => {
      const input = typeof call.input === "string" ? call.input : "";
      // 只在分析步骤让 p1/m1 失败（审计步骤独立兜底，m1 直接成功）
      if (call.model === "p1/m1" && !input.includes("主线修复审计")) {
        throw new Error("provider 限流");
      }
      return input.includes("主线修复审计") ? AUDIT_JSON : REPORT_JSON;
    });
    const { deps } = await makeDeps({
      agent,
      models: jest.fn(async () => ({
        default: "p1/m1",
        providers: [{ name: "p1", models: ["m1", "m2"] }],
      })),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("return");
    // 分析步骤：m1 失败后换 m2 采纳；审计步骤：m1 直接成功 → 共 3 次调用
    const models = agent.mock.calls.map(
      (call) => (call[0] as { model?: string }).model,
    );
    expect(models).toEqual(["p1/m1", "p1/m2", "p1/m1"]);
  });

  it("兜底链：全部模型调用失败 → fail（全灭），失败原因带各模型失败摘要", async () => {
    const agent = jest.fn(async () => {
      throw new Error("quota exhausted");
    });
    const { deps } = await makeDeps({
      agent,
      models: jest.fn(async () => ({
        default: "p1/m1",
        providers: [
          { name: "p1", models: ["m1"] },
          { name: "p2", models: ["m2"] },
        ],
      })),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("fail");
    if (outcome.type === "fail") {
      expect(outcome.reason).toContain("全部模型分析失败");
      expect(outcome.reason).toContain("p1/m1");
      expect(outcome.reason).toContain("p2/m2");
    }
    // 分析步骤两模型各试一次即 fail，不进入审计
    expect(agent).toHaveBeenCalledTimes(2);
  });

  it("审计异常 → 降级 unknown 继续，run 不 fail", async () => {
    const agent = jest.fn(async (call: { input: unknown }) => {
      const input = typeof call.input === "string" ? call.input : "";
      if (input.includes("主线修复审计")) {
        throw new Error("quota exhausted");
      }
      return REPORT_JSON;
    });
    const { deps } = await makeDeps({ agent });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("return");
    const value = (
      outcome as { type: "return"; value: Record<string, unknown> }
    ).value;
    expect(value.mainline_status).toBe("unknown");
    expect((value.metrics as Record<string, unknown>).mainline_status).toBe(
      "unknown",
    );
  });
});

describe("仓库登记表与凭据（多仓登记表 spec §4.1/§4.2；凭据 §6.6/D11）", () => {
  it("登记表加载失败（必要输入缺失）→ fail（不执行 git 不调 agent）", async () => {
    const { deps, gitCalls } = await makeDeps({
      loadRegistry: () => {
        throw new Error("仓库登记表读取失败：/x/repos.json");
      },
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("fail");
    if (outcome.type === "fail") {
      expect(outcome.reason).toContain("仓库登记表读取失败");
    }
    expect(gitCalls).toEqual([]);
    expect(deps.agent).not.toHaveBeenCalled();
  });

  it("选仓无命中 → platform_unknown：企微通知 + run success，不执行 git 不调 agent，记录 repo_key", async () => {
    const log = jest.fn(() => undefined);
    const { deps, store, gitCalls } = await makeDeps({
      log,
      loadRegistry: () => ({
        version: 1,
        repos: [
          {
            key: "linux",
            url: REPO_URL,
            mainline_ref: "msync",
            assignee_tag: "sdk",
            match: ["zzz-no-hit"],
          },
        ],
      }),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("return");
    const value = (
      outcome as { type: "return"; value: Record<string, unknown> }
    ).value;
    // 通知内容：无法识别平台 + 工单链接 + 日志头部摘要
    expect(value.content).toContain("无法识别平台，未分析");
    expect(value.content).toContain(PLATFORM_UNKNOWN_KEY);
    expect(value.content).toContain("emclient init done");
    // 产出满足 check-output 契约必填字段（产出非空即全字段校验）
    expect(value.issue_key).toBe("HIM-1");
    expect(value.url).toBe("https://j1.private.easemob.com/browse/HIM-1");
    expect(value.repo_key).toBe(PLATFORM_UNKNOWN_KEY);
    expect(value.mainline_status).toBe("unknown");
    expect(value.metrics).toEqual({
      mainline_status: "unknown",
      confidence: "low",
    });
    // 不准备 worktree、不调模型
    expect(gitCalls).toEqual([]);
    expect(deps.agent).not.toHaveBeenCalled();
    // 与「模型判定 skip」同地位：写去重记录（repo_key 记 platform_unknown）
    const record = await store.get("HIM-1");
    expect(record?.last_analyzed_updated).toBe(UPDATED);
    expect(record?.repo_key).toBe(PLATFORM_UNKNOWN_KEY);
    expect(log).toHaveBeenCalledWith(
      "info",
      "选仓无命中：无法识别平台，未分析（配置缺口信号）",
      { issueKey: "HIM-1", repoKey: PLATFORM_UNKNOWN_KEY },
    );
  });

  it("多仓登记表：标题命中 ios（顺序优先于日志里的 linux 词），用条目 url/mainline_ref 准备仓", async () => {
    const { deps, store, gitCalls } = await makeDeps(
      {
        run: jest.fn(async () =>
          fetchOutput({ issue: { summary: "iOS 端登录后重连丢会话" } }),
        ),
        loadRegistry: () => ({
          version: 1,
          repos: [
            {
              key: "ios",
              url: IOS_URL,
              mainline_ref: "chatsdk",
              assignee_tag: "sdk",
              match: ["ios"],
            },
            ...REGISTRY.repos,
          ],
        }),
      },
      { warmSlugs: [IOS_SLUG] },
    );

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("return");
    const value = (
      outcome as { type: "return"; value: Record<string, unknown> }
    ).value;
    expect(value.repo_key).toBe("ios");
    // 通知标题带命中仓标注
    expect(value.content).toContain("**SDK 日志分析报告：HIM-1 [ios]**");
    // worktree/审计全部走 ios 仓（slug 目录），linux 缓存目录不被触碰
    expect(
      gitCalls.some((args) => args.some((a) => a.includes(IOS_SLUG))),
    ).toBe(true);
    expect(
      gitCalls.some((args) => args.some((a) => a.includes(REPO_SLUG))),
    ).toBe(false);
    // 审计检出条目 mainline_ref（chatsdk 而非 linux 的 msync）
    expect(gitCalls.some((args) => args.includes("chatsdk"))).toBe(true);
    expect((await store.get("HIM-1"))?.repo_key).toBe("ios");
  });

  /** 触发一次 fetch 的 fake git（主 worktree 本地解析失败 → 锁内 fetch → 命中；审计 worktree 直接命中） */
  function fakeGitWithFetch(): { git: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const queue: GitRunResult[] = [
      { code: 1, stdout: "", stderr: "unknown revision" }, // 主 worktree verify 失败
      gitOk(""), // 锁内 fetch --no-tags origin
      gitOk(SHA), // 二次 verify 命中
      gitOk(""), // prune
      gitOk(""), // add
      gitOk(SHA), // HEAD
      gitOk(SHA), // 审计 verify
      gitOk(""), // prune
      gitOk(""), // add
      gitOk(SHA), // HEAD
    ];
    const git = jest.fn(async (args: string[]) => {
      calls.push(args);
      const next = queue.shift();
      if (!next) throw new Error(`fake git 应答耗尽：${args.join(" ")}`);
      return next;
    }) as unknown as GitRunner;
    return { git, calls };
  }

  it("条目配 account 且两个 secrets 齐备 → fetch 带 http.extraHeader（凭据不进 URL）", async () => {
    const { git, calls } = fakeGitWithFetch();
    const { deps } = await makeDeps({
      git,
      loadRegistry: () => ({
        version: 1,
        repos: [
          {
            key: "linux",
            url: REPO_URL,
            mainline_ref: "msync",
            assignee_tag: "sdk",
            account: "ci-bot",
            match: ["emclient"],
          },
        ],
      }),
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("return");
    const fetchArgs = calls.find((args) => args.includes("fetch"))!;
    const expectedBasic = Buffer.from(
      "secret-git_account_ci-bot_username:secret-git_account_ci-bot_token",
    ).toString("base64");
    expect(fetchArgs).toContain(
      `http.extraHeader=Authorization: Basic ${expectedBasic}`,
    );
    // 凭据只走 extraHeader，不进 URL
    expect(
      fetchArgs.some((a) => a.includes(REPO_URL.replace(/^https:\/\//, ""))),
    ).toBe(false);
  });

  it("账号 secrets 缺一（宽容读失败）→ warn 留痕 + 按无凭据继续（公开仓场景）", async () => {
    const log = jest.fn(() => undefined);
    const { git, calls } = fakeGitWithFetch();
    const { deps } = await makeDeps({
      git,
      log,
      loadRegistry: () => ({
        version: 1,
        repos: [
          {
            key: "linux",
            url: REPO_URL,
            mainline_ref: "msync",
            assignee_tag: "sdk",
            account: "ci-bot",
            match: ["emclient"],
          },
        ],
      }),
      secret: (name: string) => {
        if (name === "git_account_ci-bot_token") {
          throw new Error(`安全变量未注入：${name}`);
        }
        return `secret-${name}`;
      },
    });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("return");
    expect(log).toHaveBeenCalledWith(
      "warn",
      "git 账号凭据不完整，按无凭据继续（公开仓场景）",
      expect.objectContaining({
        issueKey: "HIM-1",
        account: "ci-bot",
        hasUsername: true,
        hasToken: false,
      }),
    );
    const fetchArgs = calls.find((args) => args.includes("fetch"))!;
    expect(fetchArgs.some((a) => a.includes("http.extraHeader"))).toBe(false);
  });
});

describe("正常路径", () => {
  it("输出形状含全部契约字段 + metrics；写去重记录；materialize 落盘", async () => {
    const { deps, store, workspace, agent } = await makeDeps();

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("return");
    const value = (
      outcome as { type: "return"; value: Record<string, unknown> }
    ).value;
    // 契约字段（§9 output）
    expect(value.issue_key).toBe("HIM-1");
    expect(value.url).toBe("https://j1.private.easemob.com/browse/HIM-1");
    expect(value.root_cause).toBe("重连时序竞争");
    expect(value.confidence).toBe("high");
    expect(value.mainline_status).toBe("not-fixed");
    expect(value.summary).toBe("报告摘要");
    expect(typeof value.content).toBe("string");
    expect(value.content).toContain("**SDK 日志分析报告：HIM-1 [linux]**");
    expect(value.repo_key).toBe("linux");
    expect(value.mentions).toEqual(["ZhangSan"]);
    expect(value.metrics).toEqual({
      mainline_status: "not-fixed",
      confidence: "high",
    });

    // 分析 + 审计恰两次 agent 调用（配额纪律 §6.8），均 fresh
    expect(agent).toHaveBeenCalledTimes(2);
    const callModes = agent.mock.calls.map(
      (call) => (call[0] as { mode?: string }).mode,
    );
    expect(callModes).toEqual(["fresh", "fresh"]);
    // 分析提示词注入命中条目信息（仓 key/url + notes 背景）
    const analysisInput = String(
      (agent.mock.calls[0] as [{ input: unknown }])[0].input,
    );
    expect(analysisInput).toContain("`linux`");
    expect(analysisInput).toContain(REPO_URL);
    expect(analysisInput).toContain("C++ 核心仓");

    // 分析完成写去重记录（幂等锚点 = 实时 updated + 命中仓 key）
    const record = await store.get("HIM-1");
    expect(record?.last_analyzed_updated).toBe(UPDATED);
    expect(record?.repo_key).toBe("linux");

    // 材料化落盘（§6.7）
    const conversation = await readFile(
      join(workspace, "input", "conversation.md"),
      "utf8",
    );
    expect(conversation).toContain("HIM-1: 登录后重连丢会话");
    expect(conversation).toContain("- Affected versions: 4.19.1");
    expect(conversation).toContain("- Fix versions (context only): 4.19.2");
    const taskContext = await readFile(
      join(workspace, "task-context.md"),
      "utf8",
    );
    expect(taskContext).toContain("- Selected ref: `SDK_4.19.1`");
    expect(taskContext).toContain("- Ref 依据: Jira 受影响版本：4.19.1");
    expect(taskContext).toContain("- 审计 ref（主线）: `msync`");
    expect(taskContext).toContain("`app.log`（10 字节，来源附件 app.log）");
  });

  it("agent 返回非字符串对象 → JSON.stringify 后正常解析", async () => {
    const agent = jest.fn(async (call: { input: unknown }) => {
      const input = typeof call.input === "string" ? call.input : "";
      if (input.includes("主线修复审计")) {
        return { status: "not-fixed", summary: "主线未修复" };
      }
      return {
        issue_key: "HIM-1",
        root_cause: "重连时序竞争",
        summary: "报告摘要",
        confidence: "high",
      };
    });
    const { deps } = await makeDeps({ agent });

    const outcome = await runAnalysisFlow(
      envelope({ content: PASS_CONTENT }),
      deps,
    );

    expect(outcome.type).toBe("return");
  });

  it("大模型原始输出落业务日志（第一现场）", async () => {
    const log = jest.fn(() => undefined);
    const { deps } = await makeDeps({ log });

    await runAnalysisFlow(envelope({ content: PASS_CONTENT }), deps);

    expect(log).toHaveBeenCalledWith(
      "info",
      "大模型原始输出（分析）",
      expect.objectContaining({ issueKey: "HIM-1", output: REPORT_JSON }),
    );
  });
});
