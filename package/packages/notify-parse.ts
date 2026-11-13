/**
 * 上游审查通知解析（spec §4.2：本业务的输入侧契约）。
 *
 * 输入是审查业务 run 成功输出的派生事件 payload（{ content, mentions } 或 null）。
 * 只解析两样：是否「审查通过」、工单 key；**不解析分类行**（值域对下游无意义，§4.1）、
 * **不消费 mentions**（上游 @ 谁与下游无关）。
 *
 * 解析失败不是错误——下游消费位纪律：认不出/不该做就不做（§3.4）。
 * 返回明确的 skip 原因供编排落日志；上游格式若变更，按「谁错谁修改」由责任方调整。
 */

/** 解析结果：ok 命中工单 key；否则带跳过原因（供日志，不是失败） */
export type NotifyParseResult =
  | { ok: true; issueKey: string }
  | {
      ok: false;
      skipReason:
        | "payload_not_object" // payload 为 null / 非对象（审查 skip 路径的空产出等）
        | "content_not_string" // content 缺失或非字符串
        | "not_passed" // 首行标题非「工单审查通过」（fail 审查不流转下游，v2 规则平移）
        | "issue_key_not_found"; // content 里解析不出工单 key（格式不符的异常输入）
    };

/** 工单链接行的 key 提取（spec §4.2 钉死的正则） */
const ISSUE_KEY_PATTERN = /\[([A-Z][A-Z0-9_]+-\d+)\]\(/;

/**
 * 解析上游审查通知 payload。
 * 通过判别：content 首行包含「工单审查通过」且不含「不通过」。
 */
export function parseReviewNotice(payload: unknown): NotifyParseResult {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { ok: false, skipReason: "payload_not_object" };
  }
  const content = (payload as Record<string, unknown>).content;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, skipReason: "content_not_string" };
  }

  const firstLine = content.split("\n", 1)[0] ?? "";
  if (!firstLine.includes("工单审查通过") || firstLine.includes("不通过")) {
    return { ok: false, skipReason: "not_passed" };
  }

  const issueKey = content.match(ISSUE_KEY_PATTERN)?.[1];
  if (!issueKey) {
    return { ok: false, skipReason: "issue_key_not_found" };
  }
  return { ok: true, issueKey };
}
