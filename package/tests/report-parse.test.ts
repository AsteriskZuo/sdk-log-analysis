import { describe, expect, it } from "@jest/globals";
import { parseAnalysisReport } from "../packages/report-parse.js";

const REPORT = {
  issue_key: "HIM-24204",
  root_cause: "断线重连时序竞争导致会话丢失",
  summary: "## 摘要\n日志显示重连后未恢复会话……",
  confidence: "high",
  evidence: ["10:00:01 reconnect start", "10:00:05 session null"],
  affected_modules: ["src/core/session.cpp"],
};

describe("parseAnalysisReport（spec §8 契约，三策略兜底）", () => {
  it("策略 1：直接 JSON.parse 整个输出", () => {
    const result = parseAnalysisReport(JSON.stringify(REPORT));
    expect(result).toEqual(REPORT);
  });

  it("策略 2：markdown 围栏内 JSON（整体 parse 失败后提取围栏内容）", () => {
    // 用单行 summary 避开「整文兜底先于围栏 parse 命中」的顺序细节（同 review-output 模式：
    // 候选按序尝试，每个候选先试 JSON.parse 再字段级兜底）
    const simple = { ...REPORT, summary: "单行摘要" };
    const output = `分析完成，结果如下：\n\`\`\`json\n${JSON.stringify(simple, null, 2)}\n\`\`\`\n以上。`;
    expect(parseAnalysisReport(output)).toEqual(simple);
  });

  it("策略 3：字段级兜底——字符串内含未转义英文双引号的非法 JSON 也能提取", () => {
    // 模型把「发送失败」写成了未转义英文引号（同 T22 §7 教训的负例）
    const broken = `{
  "issue_key": "HIM-24204",
  "root_cause": "实际结果仅"发送失败"",
  "summary": "见上",
  "confidence": "medium",
  "evidence": ["line1", "line2"],
  "affected_modules": ["mod-a"]
}`;
    const result = parseAnalysisReport(broken);
    expect(result).toBeDefined();
    expect(result!.issue_key).toBe("HIM-24204");
    expect(result!.confidence).toBe("medium");
    expect(result!.root_cause).toBe('实际结果仅"发送失败"');
    expect(result!.evidence).toEqual(["line1", "line2"]);
    expect(result!.affected_modules).toEqual(["mod-a"]);
  });

  it("evidence / affected_modules 可选：缺失归一空数组", () => {
    const minimal = {
      issue_key: "HIM-1",
      root_cause: "r",
      summary: "s",
      confidence: "low",
    };
    expect(parseAnalysisReport(JSON.stringify(minimal))).toEqual({
      ...minimal,
      evidence: [],
      affected_modules: [],
    });
  });

  it("缺 issue_key / confidence 非法 → undefined", () => {
    expect(
      parseAnalysisReport(
        JSON.stringify({ root_cause: "r", summary: "s", confidence: "high" }),
      ),
    ).toBeUndefined();
    expect(
      parseAnalysisReport(
        JSON.stringify({
          issue_key: "HIM-1",
          root_cause: "r",
          summary: "s",
          confidence: "sure",
        }),
      ),
    ).toBeUndefined();
  });

  it("完全无 JSON 的废话输出 → undefined（编排据此换模型/fail）", () => {
    expect(parseAnalysisReport("模型说了一堆废话但没有 JSON")).toBeUndefined();
  });

  it("agent 返回非字符串对象时由编排 JSON.stringify 后同样可解析（本模块只吃字符串）", () => {
    expect(
      parseAnalysisReport(JSON.stringify(JSON.stringify(REPORT))),
    ).toBeUndefined();
  });
});
