/**
 * 分析报告企微消息组装（spec §6.10；@ 人规则与审查业务同款）。
 *
 * 只负责 content/mentions 的形状，投递由平台出口（wecom-webhook）包办。
 * @ 人规则：@ 工单负责人（assignee，identity 旁路的 assigneeEmail/Name）——
 * 映射表命中 → userid；未命中 → 拼音全拼兜底（guessed，消息带提示行）；
 * 仍无 → 提示行 + mentions 空。
 * 通知渠道只有企业微信；不写 Jira comments（spec §2 决策 D7）。
 */

import {
  lookupWeComAccount as defaultLookupWeComAccount,
  type WeComAccount,
} from "./person-mapping.js";
import type { AnalysisReport } from "./report-parse.js";
import type { MainlineAuditResult } from "./mainline-audit.js";

/** 工单相关人的原始身份（jira-log-fetch 的 identity 旁路，未脱敏） */
export type AnalysisIdentity = {
  reporterEmail?: string;
  reporterName?: string;
  assigneeEmail?: string;
  assigneeName?: string;
};

/** wecom-webhook 出口 resultDoc 形状：content 为 markdown 正文，mentions 拼 <@userid> */
export type NotifyMessage = {
  content: string;
  /** 仅映射表命中或拼音猜中时携带 */
  mentions?: string[];
};

type LookupFn = (user: {
  emailAddress?: string;
  name?: string;
}) => Promise<WeComAccount | undefined>;

/** 主线状态行（spec §6.10）：已修复（commit 短SHA）/ 未修复 / 未确定 */
function mainlineStatusText(audit: MainlineAuditResult): string {
  if (audit.status === "already-fixed") {
    return audit.fix_commit
      ? `已修复（commit ${audit.fix_commit.slice(0, 7)}）`
      : "已修复";
  }
  if (audit.status === "not-fixed") {
    return "未修复";
  }
  return "未确定";
}

/**
 * 组装分析报告的企微消息。
 * 工单链接由调用方派生（config.jira_url + /browse/{key}，自持不依赖上游）。
 */
export async function buildAnalysisNotifyMessage(
  args: {
    issueKey: string;
    url: string;
    report: AnalysisReport;
    audit: MainlineAuditResult;
    identity?: AnalysisIdentity;
  },
  lookupWeComAccount: LookupFn = defaultLookupWeComAccount,
): Promise<NotifyMessage> {
  const { issueKey, url, report, audit, identity } = args;

  const wecomAccount = await lookupWeComAccount({
    emailAddress: identity?.assigneeEmail,
    name: identity?.assigneeName,
  });

  const lines: string[] = [
    `**SDK 日志分析报告：${issueKey}**`,
    "",
    `> 工单：[${issueKey}](${url})`,
    `> 根因：${report.root_cause}`,
    `> 置信度：${report.confidence}`,
    `> 主线状态：${mainlineStatusText(audit)}`,
    `> 分析时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
  ];

  let mentions: string[] | undefined;
  const target = identity?.assigneeEmail ?? identity?.assigneeName;
  if (wecomAccount) {
    mentions = [wecomAccount.wecomUserid];
    lines.push("");
    if (wecomAccount.guessed) {
      lines.push(
        `ℹ️ 未在映射表中找到负责人（${target}）的企微账号，已按拼音猜测 @${wecomAccount.wecomUserid}，若 @ 错或未 @ 到请补充映射表。`,
      );
      lines.push("");
    }
    lines.push(report.summary);
  } else {
    lines.push("");
    if (target) {
      lines.push(`⚠️ 未找到负责人（${target}）的企微账号，无法 @ 通知。`);
    }
    lines.push(report.summary);
  }

  return {
    content: lines.join("\n"),
    ...(mentions ? { mentions } : {}),
  };
}
