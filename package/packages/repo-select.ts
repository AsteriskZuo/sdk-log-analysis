/**
 * 选仓（多仓登记表 spec §4.2，决策 D3/D7/D8）：确定性关键词子串匹配，模型全程不参与。
 *
 * 时机：analysis-flow 的「审查通知解析通过」之后、准备 worktree 之前。
 *
 * 语料（D7）：工单标题 + 各日志附件文本的前 64 KB（materialize 之后的本地文件直读，
 * 与 ref-resolver 读日志同一批文件路径），拼接后转小写。
 *
 * 匹配（D8）：按登记表数组顺序逐条目扫描，任一等价小写的 match 关键词在语料中
 * 出现（子串包含）即命中该条目；首个命中终止（数组顺序即优先级，越具体越靠前）。
 *
 * 无命中（§4.2-3）：key 记为 platform_unknown——不准备 worktree、不调模型，
 * 由编排产出企微通知（buildPlatformUnknownNotifyMessage，含 issue_key 与日志头部
 * 摘要，方便人工补充 match 词）后 run success（与「模型判定 skip」同地位，但平台
 * 未知是配置缺口信号，要通知人）。
 */

import { closeSync, openSync, readSync } from "node:fs";
import type { NotifyMessage } from "./notify-message.js";
import type { RepoEntry, RepoRegistry } from "./repos.js";

/** 无命中时登记的仓 key（spec §4.2-3）：用于日志、通知、metrics 标注 */
export const PLATFORM_UNKNOWN_KEY = "platform_unknown";

/** 选仓语料的单份日志截取上限（spec 决策 D7：日志附件前 64 KB） */
export const SELECT_CORPUS_LOG_HEAD_BYTES = 64 * 1024;

/** 通知里日志头部摘要的截取上限（够辨认平台特征即可，避免刷爆企微消息） */
export const NOTIFY_LOG_HEAD_BYTES = 1024;

/** 选仓结果：命中带条目与命中关键词（日志用）；无命中只有原因 */
export type RepoSelectResult =
  | { ok: true; entry: RepoEntry; matchedKeyword: string }
  | { ok: false; reason: "no_match" };

/**
 * 读取文件头部至多 maxBytes 字节并按 utf8 解码（尾部可能切断多字节字符，
 * 对子串匹配与摘要展示无副作用）。文件读取失败（缺失/无权限）直接抛错——
 * 与 ref-resolver 读日志同一纪律，日志缺失属异常输入，由编排 fail。
 */
export function readFileHead(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * 拼装选仓语料（spec §4.2-1）：工单标题 + 各日志附件文本前 64 KB 直读拼接。
 * 返回原始大小写文本，小写化在 selectRepo 内完成（语料形状一目了然）。
 *
 * @param title 工单标题（审查通知解析出的工单 summary；可缺省）
 * @param logFiles 归一化日志文件的绝对路径（每份取前 64 KB）
 */
export function buildSelectCorpus(args: {
  title?: string;
  logFiles?: string[];
}): string {
  const parts: string[] = [];
  if (args.title) {
    parts.push(args.title);
  }
  for (const filePath of args.logFiles ?? []) {
    parts.push(readFileHead(filePath, SELECT_CORPUS_LOG_HEAD_BYTES));
  }
  return parts.join("\n");
}

/**
 * 选仓（spec §4.2-2，决策 D8）：语料转小写后按登记表数组顺序逐条目扫描，
 * 任一 match 关键词（加载时已小写归一）子串命中即选中该条目；首个命中终止。
 * 纯函数：不做 IO、不读 env，语料由 buildSelectCorpus 先行拼装。
 */
export function selectRepo(args: {
  corpus: string;
  registry: RepoRegistry;
}): RepoSelectResult {
  const corpus = args.corpus.toLowerCase();
  for (const entry of args.registry.repos) {
    for (const keyword of entry.match) {
      // 防御性小写化：loadRepoRegistry 已归一，手工构造的登记表同样按小写语义匹配
      const needle = keyword.toLowerCase();
      if (needle !== "" && corpus.includes(needle)) {
        return { ok: true, entry, matchedKeyword: needle };
      }
    }
  }
  return { ok: false, reason: "no_match" };
}

/**
 * 组装「无法识别平台，未分析」的企微通知（spec §4.2-3）：
 * 含 issue_key 与日志头部摘要，方便人工补充登记表 match 关键词（配置缺口信号，
 * 要通知人；但不 @ 任何人——配置缺口的维护对象在登记表，不在工单负责人）。
 * 消息形状复用 notify-message 的 NotifyMessage（content 为 markdown 正文），
 * 投递由平台出口（wecom-webhook）包办，与「模型判定 skip」同地位：run success。
 *
 * @param issueKey 工单 key
 * @param url 工单链接（调用方由 config.jira_url 派生；可缺省，缺省只写 key）
 * @param logHead 日志头部摘要（建议 readFileHead(首份日志, NOTIFY_LOG_HEAD_BYTES)；
 *   无日志附件时缺省）
 */
export function buildPlatformUnknownNotifyMessage(args: {
  issueKey: string;
  url?: string;
  logHead?: string;
}): NotifyMessage {
  const { issueKey, url, logHead } = args;
  const lines: string[] = [
    `**SDK 日志分析：无法识别平台，未分析（${PLATFORM_UNKNOWN_KEY}）**`,
    "",
    `> 工单：${url ? `[${issueKey}](${url})` : issueKey}`,
    `> 原因：工单标题与日志前 64KB 未命中仓库登记表任何选仓关键词`,
  ];
  if (logHead && logHead.trim() !== "") {
    lines.push(
      "",
      "日志头部摘要（供人工补充登记表 match 关键词参考）：",
      "```",
      logHead.trimEnd(),
      "```",
    );
  } else {
    lines.push("", "（无日志附件可供摘要）");
  }
  return { content: lines.join("\n") };
}
