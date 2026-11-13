/**
 * 分析去重记录存储（spec §6 步骤 4）。
 *
 * 落点 {dataDir}/analysis-record.json，按工单 key 记录 { last_analyzed_updated }——
 * 去重锚点是**本业务自己拉到的实时工单 updated**（上游审查输出里没有 updated 字段）。
 * 语义：实时 updated 与记录相同 → 跳过；updated 缺失 → 不去重（每次都分析）+ warn
 * （warn 由编排落，本模块只管存取）。写盘原子化（temp + rename）；同 session
 * （= 工单 key）run 串行，无需自锁，进程内写锁链保留无害。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sdk } from "@asteriskzuo/agent-sdk";

export type AnalysisRecord = {
  /** 分析时实时工单的 updated 时间戳；分析时 updated 缺失则无此键（该记录不参与去重） */
  last_analyzed_updated?: string;
  /**
   * 本次分析命中的仓 key（多仓登记表 spec §4.5；platform_unknown 分支记
   * "platform_unknown"）。选仓之前的 skip 路径（F1/F2/无日志）与旧记录无此字段，
   * 读口一律按可空处理，旧记录不回填
   */
  repo_key?: string;
  /** 本次记录写入时间（ISO），供控制台/日志排查 */
  analyzed_at: string;
};

type AnalysisRecordsFile = Record<string, AnalysisRecord>;

export class AnalysisRecordStore {
  private readonly file: string;
  private writeChain: Promise<unknown> = Promise.resolve();
  private nextTempId = 0;

  constructor(private readonly dataDir: string = sdk.dataDir()) {
    this.file = join(dataDir, "analysis-record.json");
  }

  async get(issueKey: string): Promise<AnalysisRecord | undefined> {
    const data = await this.readAll();
    return data[issueKey];
  }

  /**
   * 去重判断：实时 updated 与记录相同 → true（跳过）；
   * 无记录 / updated 缺失（任一侧）→ false（照常分析）。
   */
  async shouldSkip(
    issueKey: string,
    liveUpdated: string | undefined,
  ): Promise<boolean> {
    if (!liveUpdated) {
      return false;
    }
    const record = await this.get(issueKey);
    return record?.last_analyzed_updated === liveUpdated;
  }

  /** 写分析记录（分析完成 / 自持过滤命中 / 无日志分支共用同一去重锚点）。
   *  repoKey：本次命中的仓 key（含 platform_unknown）；选仓之前的 skip 路径不传 */
  async markAnalyzed(
    issueKey: string,
    liveUpdated: string | undefined,
    repoKey?: string,
  ): Promise<void> {
    const analyzedAt = new Date().toISOString();
    return this.withWriteLock(async () => {
      const data = await this.readAll();
      data[issueKey] = {
        ...(liveUpdated ? { last_analyzed_updated: liveUpdated } : {}),
        ...(repoKey ? { repo_key: repoKey } : {}),
        analyzed_at: analyzedAt,
      };
      await this.writeAll(data);
    });
  }

  private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readAll(): Promise<AnalysisRecordsFile> {
    try {
      const content = await readFile(this.file, "utf8");
      return JSON.parse(content) as AnalysisRecordsFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  /** 原子写：temp + rename（同目录 rename 原子替换，run 中断不留半截文件） */
  private async writeAll(data: AnalysisRecordsFile): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const temp = `${this.file}.${process.pid}.${this.nextTempId++}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temp, this.file);
  }
}
