import { describe, expect, it } from "@jest/globals";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisRecordStore } from "../packages/analysis-records.js";

const UPDATED = "2026-11-12T10:00:00.000+0800";

async function makeStore(): Promise<{
  dir: string;
  store: AnalysisRecordStore;
}> {
  const dir = await mkdtemp(join(tmpdir(), "analysis-records-"));
  return { dir, store: new AnalysisRecordStore(dir) };
}

describe("AnalysisRecordStore（spec §6 步骤 4）", () => {
  it("无记录 → shouldSkip false（需要分析）", async () => {
    const { store } = await makeStore();
    await expect(store.shouldSkip("HIM-1", UPDATED)).resolves.toBe(false);
    await expect(store.get("HIM-1")).resolves.toBeUndefined();
  });

  it("updated 相同 → 跳过去重", async () => {
    const { store } = await makeStore();
    await store.markAnalyzed("HIM-1", UPDATED);

    await expect(store.shouldSkip("HIM-1", UPDATED)).resolves.toBe(true);
  });

  it("updated 不同 → 重新分析（不跳）", async () => {
    const { store } = await makeStore();
    await store.markAnalyzed("HIM-1", UPDATED);

    await expect(
      store.shouldSkip("HIM-1", "2026-11-12T11:00:00.000+0800"),
    ).resolves.toBe(false);
  });

  it("updated 缺失（任一侧）→ 不去重（每次都分析）", async () => {
    const { store } = await makeStore();
    // 实时 updated 缺失 → 不跳
    await store.markAnalyzed("HIM-1", UPDATED);
    await expect(store.shouldSkip("HIM-1", undefined)).resolves.toBe(false);
    // 记录无 last_analyzed_updated（分析时 updated 缺失）→ 不跳
    await store.markAnalyzed("HIM-2", undefined);
    await expect(store.shouldSkip("HIM-2", UPDATED)).resolves.toBe(false);
    const record = await store.get("HIM-2");
    expect(record?.last_analyzed_updated).toBeUndefined();
    expect(typeof record?.analyzed_at).toBe("string");
  });

  it("记录语义：{ last_analyzed_updated, analyzed_at } 按 key 落 analysis-record.json", async () => {
    const { dir, store } = await makeStore();
    await store.markAnalyzed("HIM-1", UPDATED);

    const file = JSON.parse(
      await readFile(join(dir, "analysis-record.json"), "utf8"),
    ) as Record<string, { last_analyzed_updated?: string }>;
    expect(file["HIM-1"]?.last_analyzed_updated).toBe(UPDATED);
  });

  it("原子写：temp + rename，写完后目录无 .tmp 残留", async () => {
    const { dir, store } = await makeStore();
    await store.markAnalyzed("HIM-1", UPDATED);
    await store.markAnalyzed("HIM-1", "2026-11-12T12:00:00.000+0800");

    const entries = await readdir(dir);
    expect(entries).toEqual(["analysis-record.json"]);
    // 第二次写入覆盖生效
    await expect(store.get("HIM-1")).resolves.toMatchObject({
      last_analyzed_updated: "2026-11-12T12:00:00.000+0800",
    });
  });

  it("多 key 共存，互不干扰", async () => {
    const { store } = await makeStore();
    await store.markAnalyzed("HIM-1", UPDATED);
    await store.markAnalyzed("HIM-2", UPDATED);

    await expect(store.shouldSkip("HIM-1", UPDATED)).resolves.toBe(true);
    await expect(store.shouldSkip("HIM-2", UPDATED)).resolves.toBe(true);
    await expect(store.shouldSkip("HIM-3", UPDATED)).resolves.toBe(false);
  });
});
