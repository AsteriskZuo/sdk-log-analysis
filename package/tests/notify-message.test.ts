import { describe, expect, it } from "@jest/globals";
import { buildAnalysisNotifyMessage } from "../packages/notify-message.js";
import type { AnalysisReport } from "../packages/report-parse.js";
import type { MainlineAuditResult } from "../packages/mainline-audit.js";

const REPORT: AnalysisReport = {
  issue_key: "HIM-24204",
  root_cause: "重连时序竞争导致会话丢失",
  summary: "## 摘要\n证据与推断分离……",
  confidence: "high",
  evidence: [],
  affected_modules: [],
};

const AUDIT_FIXED: MainlineAuditResult = {
  status: "already-fixed",
  summary: "主线已修复",
  fix_commit: "abcdef1234567890",
};

const URL = "https://j1.private.easemob.com/browse/HIM-24204";

function makeArgs(overrides: Record<string, unknown> = {}) {
  return {
    issueKey: "HIM-24204",
    url: URL,
    report: REPORT,
    audit: AUDIT_FIXED as MainlineAuditResult,
    identity: {
      assigneeEmail: "zhangsan@example.com",
      assigneeName: "zhangsan",
    },
    ...overrides,
  };
}

describe("buildAnalysisNotifyMessage（spec §6.10）", () => {
  it("映射表命中 → mentions 带 userid，content 形状完整", async () => {
    const message = await buildAnalysisNotifyMessage(makeArgs(), async () => ({
      wecomUserid: "ZhangSan",
      wecomName: "张三",
    }));

    expect(message.mentions).toEqual(["ZhangSan"]);
    // content 形状：标题 + 引用五行（工单/根因/置信度/主线状态/分析时间）+ 摘要
    const lines = message.content.split("\n");
    expect(lines[0]).toBe("**SDK 日志分析报告：HIM-24204**");
    expect(lines[2]).toBe(
      "> 工单：[HIM-24204](https://j1.private.easemob.com/browse/HIM-24204)",
    );
    expect(lines[3]).toBe("> 根因：重连时序竞争导致会话丢失");
    expect(lines[4]).toBe("> 置信度：high");
    expect(lines[5]).toBe("> 主线状态：已修复（commit abcdef1）");
    expect(lines[6]).toMatch(
      /^> 分析时间：\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}$/,
    );
    expect(message.content).toContain("## 摘要");
    expect(message.content).not.toContain("ℹ️");
    expect(message.content).not.toContain("⚠️");
  });

  it("映射未命中 → 拼音兜底（guessed）：mentions 带猜测 userid + 提示行", async () => {
    const message = await buildAnalysisNotifyMessage(makeArgs(), async () => ({
      wecomUserid: "XueFei",
      wecomName: "薛飞",
      guessed: true,
    }));

    expect(message.mentions).toEqual(["XueFei"]);
    expect(message.content).toContain(
      "ℹ️ 未在映射表中找到负责人（zhangsan@example.com）的企微账号，已按拼音猜测 @XueFei",
    );
    expect(message.content).toContain("## 摘要");
  });

  it("查不到账号 → 提示行 + mentions 空（不携带 mentions 键）", async () => {
    const message = await buildAnalysisNotifyMessage(
      makeArgs(),
      async () => undefined,
    );

    expect(message.mentions).toBeUndefined();
    expect(message.content).toContain(
      "⚠️ 未找到负责人（zhangsan@example.com）的企微账号，无法 @ 通知。",
    );
    expect(message.content).toContain("## 摘要");
  });

  it("无 identity → 无提示行、mentions 空，形状仍完整", async () => {
    const message = await buildAnalysisNotifyMessage(
      makeArgs({ identity: undefined }),
      async () => undefined,
    );

    expect(message.mentions).toBeUndefined();
    expect(message.content).not.toContain("⚠️");
    expect(message.content).toContain("**SDK 日志分析报告：HIM-24204**");
  });

  it("主线状态映射：not-fixed → 未修复；unknown → 未确定", async () => {
    const notFixed = await buildAnalysisNotifyMessage(
      makeArgs({ audit: { status: "not-fixed", summary: "x" } }),
      async () => undefined,
    );
    expect(notFixed.content).toContain("> 主线状态：未修复");

    const unknown = await buildAnalysisNotifyMessage(
      makeArgs({ audit: { status: "unknown", summary: "x" } }),
      async () => undefined,
    );
    expect(unknown.content).toContain("> 主线状态：未确定");
  });

  it("already-fixed 无 fix_commit → 仅「已修复」（不带 commit）", async () => {
    const message = await buildAnalysisNotifyMessage(
      makeArgs({ audit: { status: "already-fixed", summary: "x" } }),
      async () => undefined,
    );
    expect(message.content).toContain("> 主线状态：已修复\n");
  });

  it("@ 查询入参：assigneeEmail/Name 透传（@ 负责人）", async () => {
    let queried: unknown;
    await buildAnalysisNotifyMessage(
      makeArgs({
        identity: { assigneeEmail: "a@b.c", assigneeName: "adev" },
      }),
      async (user) => {
        queried = user;
        return undefined;
      },
    );
    expect(queried).toEqual({ emailAddress: "a@b.c", name: "adev" });
  });
});
