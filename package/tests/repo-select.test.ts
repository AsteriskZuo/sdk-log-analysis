import { describe, expect, it } from "@jest/globals";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlatformUnknownNotifyMessage,
  buildSelectCorpus,
  PLATFORM_UNKNOWN_KEY,
  readFileHead,
  selectRepo,
  SELECT_CORPUS_LOG_HEAD_BYTES,
} from "../packages/repo-select.js";
import { loadRepoRegistry } from "../packages/repos.js";

/** 真实登记表（包根 repos.json）：顺序即优先级纪律直接对真表断言 */
const registry = loadRepoRegistry();

async function makeLogs(files: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "repo-select-"));
  const paths: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await writeFile(filePath, content, "utf8");
    paths.push(filePath);
  }
  return paths;
}

describe("selectRepo（命中规则，spec §4.2 / 决策 D3/D8）", () => {
  it("命中 ios 词：日志含 iPhone → 选中 ios 仓", () => {
    const result = selectRepo({
      corpus: "用户在 iPhone 15 上登录即闪退",
      registry,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.key).toBe("ios");
      expect(result.matchedKeyword).toBe("iphone");
    }
  });

  it("命中 flutter 词：标题含 flutter → 选中 flutter 仓", () => {
    const result = selectRepo({
      corpus: "flutter 集成后收不到消息",
      registry,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.key).toBe("flutter");
    }
  });

  it("大小写不敏感：语料大写 IOS / HARMONYOS 照常命中", () => {
    expect(selectRepo({ corpus: "IOS 端崩溃", registry })).toMatchObject({
      ok: true,
      entry: { key: "ios" },
    });
    expect(
      selectRepo({ corpus: "HARMONYOS 启动失败", registry }),
    ).toMatchObject({ ok: true, entry: { key: "harmony" } });
  });

  it("中文关键词：鸿蒙 → harmony；安卓 → android", () => {
    expect(
      selectRepo({ corpus: "鸿蒙设备收不到推送", registry }),
    ).toMatchObject({ ok: true, entry: { key: "harmony" } });
    expect(selectRepo({ corpus: "安卓端登录失败", registry })).toMatchObject({
      ok: true,
      entry: { key: "android" },
    });
  });

  it("带空格/连字符的多词关键词：react native 三种写法都命中 react-native 仓", () => {
    for (const corpus of [
      "react-native 初始化报错",
      "reactnative bridge 异常",
      "react native 环境收不到消息",
    ]) {
      expect(selectRepo({ corpus, registry })).toMatchObject({
        ok: true,
        entry: { key: "react-native" },
      });
    }
  });

  it("多词命中取数组顺序首个：iOS 日志提到 linux core 命中 ios 而非 linux（spec §4.0 顺序纪律）", () => {
    const result = selectRepo({
      corpus: "ios 端偶发断连，堆栈落在 linux core 层",
      registry,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.key).toBe("ios");
      expect(result.matchedKeyword).toBe("ios");
    }
  });

  it("多词命中顺序优先之二：android 在 harmony 之前", () => {
    const result = selectRepo({
      corpus: "android 与 harmony 双端都复现",
      registry,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.key).toBe("android");
    }
  });

  it("无命中 → ok:false / no_match（编排记 platform_unknown）", () => {
    const result = selectRepo({
      corpus: "桌面端消息不同步，见附件日志",
      registry,
    });
    expect(result).toEqual({ ok: false, reason: "no_match" });
    expect(PLATFORM_UNKNOWN_KEY).toBe("platform_unknown");
  });
});

describe("buildSelectCorpus（语料拼装：工单标题 + 日志前 64KB，决策 D7）", () => {
  it("标题 + 各日志文件拼接（原始大小写保留，小写化在 selectRepo 内）", async () => {
    const logFiles = await makeLogs({
      "a.log": "EMClient init ok",
      "b.log": "iPhone 15 Pro",
    });
    const corpus = buildSelectCorpus({ title: "iOS 崩溃", logFiles });
    expect(corpus).toBe("iOS 崩溃\nEMClient init ok\niPhone 15 Pro");
    expect(selectRepo({ corpus, registry })).toMatchObject({
      ok: true,
      entry: { key: "ios" },
    });
  });

  it("日志超 64KB 截断：64KB 之后的内容不进语料", async () => {
    const tail = "FLUTTER_MARKER_BEYOND_64KB";
    const logFiles = await makeLogs({
      "big.log": "x".repeat(SELECT_CORPUS_LOG_HEAD_BYTES) + tail,
    });
    const corpus = buildSelectCorpus({ title: "", logFiles });
    expect(corpus).not.toContain(tail);
    expect(corpus.length).toBe(SELECT_CORPUS_LOG_HEAD_BYTES);
  });

  it("标题与日志均可缺省：空语料 → 无命中", () => {
    expect(buildSelectCorpus({})).toBe("");
    expect(selectRepo({ corpus: "", registry })).toEqual({
      ok: false,
      reason: "no_match",
    });
  });
});

describe("readFileHead（文件头部直读）", () => {
  it("按字节上限截断", async () => {
    const [filePath] = await makeLogs({
      "a.log": "abcdefghijklmnopqrstuvwxyz",
    });
    expect(readFileHead(filePath, 10)).toBe("abcdefghij");
  });
});

describe("buildPlatformUnknownNotifyMessage（spec §4.2-3：配置缺口通知）", () => {
  it("含 issue_key、工单链接与日志头部摘要；mentions 缺省（不 @ 人）", () => {
    const message = buildPlatformUnknownNotifyMessage({
      issueKey: "HIM-24170",
      url: "https://j1.private.easemob.com/browse/HIM-24170",
      logHead: "2026-11-13 10:00:00 sdk init",
    });
    expect(message.content).toContain("无法识别平台，未分析");
    expect(message.content).toContain(PLATFORM_UNKNOWN_KEY);
    expect(message.content).toContain(
      "[HIM-24170](https://j1.private.easemob.com/browse/HIM-24170)",
    );
    expect(message.content).toContain("2026-11-13 10:00:00 sdk init");
    expect(message.mentions).toBeUndefined();
  });

  it("无 url → 只写工单 key；无日志摘要 → 明示无日志附件", () => {
    const message = buildPlatformUnknownNotifyMessage({
      issueKey: "HIM-24170",
    });
    expect(message.content).toContain("> 工单：HIM-24170");
    expect(message.content).toContain("（无日志附件可供摘要）");
    expect(message.content).not.toContain("```");
  });
});
