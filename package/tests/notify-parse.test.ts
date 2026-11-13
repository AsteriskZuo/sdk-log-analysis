import { describe, expect, it } from "@jest/globals";
import { parseReviewNotice } from "../packages/notify-parse.js";

// spec §4.1 钉死的上游 content 稳定形状（审查业务 notify-message.ts 产出）
const PASS_CONTENT = [
  "**工单审查通过 ✅**",
  "",
  "> 工单：[HIM-24204](https://j1.private.easemob.com/browse/HIM-24204)",
  "> 分类：Bug",
  "> 审查时间：2026/11/12 15:30:00",
  "",
  "审查摘要文本",
].join("\n");

const FAIL_CONTENT = [
  "**工单审查不通过 ❌**",
  "",
  "> 工单：[HIM-24204](https://j1.private.easemob.com/browse/HIM-24204)",
  "> 原因：缺少 AppKey",
  "> 审查时间：2026/11/12 15:30:00",
].join("\n");

describe("parseReviewNotice（spec §4.2）", () => {
  it("通过标题 + 工单链接 → ok，提取 issue_key", () => {
    const result = parseReviewNotice({
      content: PASS_CONTENT,
      mentions: ["ZhangSan"],
    });
    expect(result).toEqual({ ok: true, issueKey: "HIM-24204" });
  });

  it("不通过标题 → not_passed 跳过（fail 审查不流转下游）", () => {
    const result = parseReviewNotice({ content: FAIL_CONTENT, mentions: [] });
    expect(result).toEqual({ ok: false, skipReason: "not_passed" });
  });

  it("payload 为 null → payload_not_object（审查 skip 路径空产出，安静跳过）", () => {
    expect(parseReviewNotice(null)).toEqual({
      ok: false,
      skipReason: "payload_not_object",
    });
  });

  it("payload 非对象（字符串/数组）→ payload_not_object", () => {
    expect(parseReviewNotice("just a string")).toEqual({
      ok: false,
      skipReason: "payload_not_object",
    });
    expect(parseReviewNotice([1, 2])).toEqual({
      ok: false,
      skipReason: "payload_not_object",
    });
  });

  it("content 缺失/非字符串 → content_not_string", () => {
    expect(parseReviewNotice({})).toEqual({
      ok: false,
      skipReason: "content_not_string",
    });
    expect(parseReviewNotice({ content: 42 })).toEqual({
      ok: false,
      skipReason: "content_not_string",
    });
  });

  it("通过标题但无工单链接行 → issue_key_not_found（格式异常输入）", () => {
    const result = parseReviewNotice({
      content: "**工单审查通过 ✅**\n\n没有链接行",
    });
    expect(result).toEqual({ ok: false, skipReason: "issue_key_not_found" });
  });

  it("key 正则：项目前缀允许大写字母/数字/下划线（SDK_2-123）", () => {
    const result = parseReviewNotice({
      content:
        "**工单审查通过 ✅**\n> 工单：[SDK_2-123](https://j1.private.easemob.com/browse/SDK_2-123)",
    });
    expect(result).toEqual({ ok: true, issueKey: "SDK_2-123" });
  });

  it("key 正则：小写前缀不匹配", () => {
    const result = parseReviewNotice({
      content:
        "**工单审查通过 ✅**\n> 工单：[him-1](https://j1.private.easemob.com/browse/him-1)",
    });
    expect(result).toEqual({ ok: false, skipReason: "issue_key_not_found" });
  });

  it("不解析分类行、不消费 mentions：分类值任意/mentions 任意都不影响结果", () => {
    const withOddCategory = parseReviewNotice({
      content: PASS_CONTENT.replace("> 分类：Bug", "> 分类：类型误标：需求"),
      mentions: ["A", "B"],
    });
    expect(withOddCategory).toEqual({ ok: true, issueKey: "HIM-24204" });
    const noCategory = parseReviewNotice({
      content: PASS_CONTENT.replace("> 分类：Bug\n", ""),
      mentions: [],
    });
    expect(noCategory).toEqual({ ok: true, issueKey: "HIM-24204" });
  });

  it("解析结果形状：ok 时仅携带 issueKey（不带 content/mentions 等上游字段）", () => {
    const result = parseReviewNotice({ content: PASS_CONTENT });
    expect(Object.keys(result).sort()).toEqual(["issueKey", "ok"]);
    expect(result).toEqual({ ok: true, issueKey: "HIM-24204" });
  });
});
