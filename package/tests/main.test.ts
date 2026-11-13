import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";

/** 管道喂 mock 信封跑构建产物，返回 {code, stdout}（契约：结果在 stdout 最后一行 JSON） */
function run(stdin: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ["dist/apps/main/index.js"], {
      input: stdin,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, stdout: e.stdout };
  }
}

function lastResult(stdout: string): {
  ok: boolean;
  output?: unknown;
  reason?: string;
} {
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

// main 薄壳（T3 接线态）：读信封 → analysis-flow → sdk.return/fail。
// 输入过滤路径（payload null / 非通过标题 / 解析不出 key）在触碰 secrets/dataDir
// 之前短路 return(null)，故 mock 信封无需注入即可走到出口。
describe("main 程序（接线 analysis-flow）", () => {
  it("无注入输入（空 stdin）→ 非零退出", () => {
    const r = run("");
    expect(r.code).not.toBe(0);
  });

  it("payload 为 null → ok:true + output:null + exit 0（安静跳过）", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: { payload: null },
        workspace: ".",
      }),
    );
    expect(r.code).toBe(0);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(true);
    expect(result.output).toBeNull();
  });

  it("非通过标题 → ok:true + output:null（fail 审查不流转下游）", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: {
          payload: {
            content:
              "**工单审查不通过 ❌**\n> 工单：[HIM-1](https://j1.private.easemob.com/browse/HIM-1)",
            mentions: [],
          },
        },
        workspace: ".",
      }),
    );
    expect(r.code).toBe(0);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(true);
    expect(result.output).toBeNull();
  });

  it("通过标题但无工单链接行 → ok:true + output:null（warn + 安静跳过）", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: {
          payload: { content: "**工单审查通过 ✅**", mentions: [] },
        },
        workspace: ".",
      }),
    );
    expect(r.code).toBe(0);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(true);
    expect(result.output).toBeNull();
  });

  it("通过标题且解析出 key，但信封缺 secrets/dataDir → 非零退出（流程进入拉取阶段抛错）", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: {
          payload: {
            content:
              "**工单审查通过 ✅**\n> 工单：[HIM-1](https://j1.private.easemob.com/browse/HIM-1)",
            mentions: [],
          },
        },
        workspace: ".",
      }),
    );
    expect(r.code).not.toBe(0);
  });
});
