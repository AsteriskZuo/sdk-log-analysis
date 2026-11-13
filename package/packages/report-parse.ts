/**
 * 分析报告 JSON 解析（spec §8 报告契约；多策略兜底参照 review-output.ts 模式）。
 *
 * 模型输出有时是 markdown 代码块包裹或未转义引号的非法 JSON，
 * parseAnalysisReport 按优先级尝试多种解析策略，确保稳健提取：
 * 1. 直接 JSON.parse 整个输出；
 * 2. 提取 markdown 代码块内的 JSON 再 parse；
 * 3. 字段级兜底（锚定字段名提取，容忍字符串内未转义引号）。
 */

export type AnalysisConfidence = "high" | "medium" | "low";

/** 分析报告（spec §8 输出契约；evidence / affected_modules 可选，解析时按字符串数组过滤） */
export type AnalysisReport = {
  issue_key: string;
  root_cause: string;
  summary: string;
  confidence: AnalysisConfidence;
  evidence: string[];
  affected_modules: string[];
};

const CONFIDENCES: readonly AnalysisConfidence[] = ["high", "medium", "low"];

function normalizeConfidence(value: unknown): AnalysisConfidence | undefined {
  return typeof value === "string" &&
    (CONFIDENCES as readonly string[]).includes(value)
    ? (value as AnalysisConfidence)
    : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item !== "",
  );
}

function toReport(parsed: Record<string, unknown>): AnalysisReport | undefined {
  const issueKey =
    typeof parsed.issue_key === "string" && parsed.issue_key !== ""
      ? parsed.issue_key
      : undefined;
  const confidence = normalizeConfidence(parsed.confidence);
  if (!issueKey || !confidence) {
    return undefined;
  }
  return {
    issue_key: issueKey,
    root_cause: typeof parsed.root_cause === "string" ? parsed.root_cause : "",
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    confidence,
    evidence: normalizeStringArray(parsed.evidence),
    affected_modules: normalizeStringArray(parsed.affected_modules),
  };
}

function tryParseJson(text: string): AnalysisReport | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return toReport(parsed);
    }
  } catch {
    // fall through to next strategy
  }
  return undefined;
}

/** 字段级兜底：锚定字段名提取（值以「下一个字段名或收尾大括号」为界，不信任引号配对） */
function salvageReportFields(text: string): AnalysisReport | undefined {
  const issueKey = text.match(/"issue_key"\s*:\s*"([^"\s]+)"/)?.[1];
  const confidenceRaw = text.match(
    /"confidence"\s*:\s*"(high|medium|low)"/,
  )?.[1];
  if (!issueKey || !confidenceRaw) {
    return undefined;
  }

  const field = (key: string): string | undefined =>
    text.match(
      new RegExp(
        `"${key}"\\s*:\\s*"([\\s\\S]*?)"(?=\\s*,\\s*"[a-zA-Z_]+"\\s*:|\\s*\\})`,
      ),
    )?.[1];

  const arrayField = (key: string): string[] => {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    return match
      ? [...match[1].matchAll(/"([^"]*)"/g)]
          .map((item) => item[1])
          .filter((item) => item !== "")
      : [];
  };

  return {
    issue_key: issueKey,
    root_cause: field("root_cause") ?? "",
    summary: field("summary") ?? "",
    confidence: confidenceRaw as AnalysisConfidence,
    evidence: arrayField("evidence"),
    affected_modules: arrayField("affected_modules"),
  };
}

/**
 * 从模型原始输出解析分析报告；三种策略全部失败返回 undefined（编排据此换模型或 fail）。
 */
export function parseAnalysisReport(
  output: string,
): AnalysisReport | undefined {
  const candidates = [output.trim()];
  const fenceMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    candidates.push(fenceMatch[1].trim());
  }

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate) ?? salvageReportFields(candidate);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}
