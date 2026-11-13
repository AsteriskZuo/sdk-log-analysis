import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";

/** 管道喂 mock 信封跑构建产物，返回 {code, stdout}（契约：结果在 stdout 最后一行 JSON） */
function run(stdin: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["dist/apps/check-input/index.js"],
      { input: stdin, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, stdout: e.stdout };
  }
}

/** 最小注入信封（check 阶段平台注入：contract_version/input/workspace，无 secrets/endpoint） */
function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract_version: "v1",
    input: { payload: { content: "**工单审查通过 ✅**", mentions: [] } },
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

// 本业务 input 契约全 optional（spec §9 决策点 D4：null/缺字段 payload 是正常输入，
// 语义过滤归主程序）——check-input 对任何合法信封都应放行。
describe("check-input 程序（input 契约全 optional，一律放行）", () => {
  it("完整 payload（content + mentions）→ ok:true + exit 0", () => {
    const r = run(envelope());
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });

  it("payload 为 null（上游 skip 空产出）→ ok:true", () => {
    const r = run(envelope({ input: { payload: null } }));
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });

  it("payload 缺字段（{}）→ ok:true", () => {
    const r = run(envelope({ input: { payload: {} } }));
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });

  it("payload.content 类型不符（number）→ 仍放行（可选项不校验，过滤归 main）", () => {
    const r = run(envelope({ input: { payload: { content: 42 } } }));
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });
});
