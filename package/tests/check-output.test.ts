import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";

/** 管道喂 mock 信封跑构建产物，返回 {code, stdout}（契约：结果在 stdout 最后一行 JSON） */
function run(stdin: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["dist/apps/check-output/index.js"],
      { input: stdin, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, stdout: e.stdout };
  }
}

/** check-output 阶段信封：output = 主程序产出（仅本阶段注入） */
function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract_version: "v1",
    input: { payload: { content: "**工单审查通过 ✅**" } },
    workspace: ".",
    ...over,
  });
}

function lastResult(stdout: string): {
  ok: boolean;
  reason?: string;
} {
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

/** 满足 output + metrics 契约的完整产出 */
function fullOutput(over: Record<string, unknown> = {}): unknown {
  return {
    content: "**SDK 日志分析报告：HIM-24204**",
    mentions: ["zhangsan"],
    issue_key: "HIM-24204",
    url: "https://j1.private.easemob.com/browse/HIM-24204",
    root_cause: "一句话根因",
    confidence: "high",
    mainline_status: "unknown",
    summary: "报告摘要",
    metrics: { mainline_status: "unknown", confidence: "high" },
    ...over,
  };
}

describe("check-output 程序（output 契约 + metrics 校验 + null 逃生门）", () => {
  it("完整产出 → ok:true + exit 0", () => {
    const r = run(envelope({ output: fullOutput() }));
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });

  it("output 为 null（skip 路径合法空产出）→ 逃生门放行，ok:true", () => {
    const r = run(envelope({ output: null }));
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });

  it("output 未注入（undefined）→ 视同空产出，ok:true", () => {
    const r = run(envelope());
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });

  it("产出非空但缺 content → ok:false，reason 含缺失路径", () => {
    const out = fullOutput() as Record<string, unknown>;
    delete out.content;
    const r = run(envelope({ output: out }));
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("content");
  });

  it("产出非空但缺 metrics.mainline_status → ok:false，reason 含指标键", () => {
    const r = run(
      envelope({ output: fullOutput({ metrics: { confidence: "high" } }) }),
    );
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("mainline_status");
  });

  it("metrics 类型错（confidence 为 number）→ ok:false", () => {
    const r = run(
      envelope({
        output: fullOutput({
          metrics: { mainline_status: "unknown", confidence: 1 },
        }),
      }),
    );
    expect(r.code).toBe(1);
    expect(lastResult(r.stdout).ok).toBe(false);
  });
});
