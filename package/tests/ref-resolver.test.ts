import { describe, expect, it } from "@jest/globals";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findCoreVersion,
  findExplicitRef,
  normalizeSdkVersion,
  resolveRef,
} from "../packages/ref-resolver.js";

async function makeLogs(files: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "ref-resolver-"));
  const paths: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await writeFile(filePath, content, "utf8");
    paths.push(filePath);
  }
  return paths;
}

describe("normalizeSdkVersion（spec §6.5 归一化）", () => {
  it("4.19.1 / SDK 4.19.1 / SDK_4.19.1 → SDK_4.19.1", () => {
    for (const raw of ["4.19.1", "SDK 4.19.1", "SDK_4.19.1", "sdk-4.19.1"]) {
      expect(normalizeSdkVersion(raw)).toEqual({
        version: "4.19.1",
        tag: "SDK_4.19.1",
        raw,
      });
    }
  });

  it("非版本值 → undefined（msync、分支名不归一）", () => {
    expect(normalizeSdkVersion("msync")).toBeUndefined();
    expect(normalizeSdkVersion("feature/foo")).toBeUndefined();
    expect(normalizeSdkVersion("")).toBeUndefined();
  });
});

describe("findExplicitRef（第一级：叙述显式 ref）", () => {
  it("中文「分支：msync」", () => {
    expect(findExplicitRef("复现分支：msync，请查")).toBe("msync");
  });

  it("emclient-linux 限定 ref", () => {
    expect(findExplicitRef("emclient-linux: release/4.19")).toBe(
      "release/4.19",
    );
  });

  it("branch/tag/commit 英文键", () => {
    expect(findExplicitRef("please use tag: SDK_4.19.1")).toBe("SDK_4.19.1");
    expect(findExplicitRef("commit=abc1234")).toBe("abc1234");
  });

  it("裸 SDK_ 标签也算显式 ref", () => {
    expect(findExplicitRef("版本是 SDK_4.19.1 的日志")).toBe("SDK_4.19.1");
  });

  it("无显式 ref → undefined", () => {
    expect(findExplicitRef("登录失败，见附件日志")).toBeUndefined();
  });
});

describe("findCoreVersion（第三级：日志 core version 行）", () => {
  it("按文件序取首个命中", async () => {
    const logs = await makeLogs({
      "a.log": "init\ncore version: 4.19.1\n",
      "b.log": "core version: 4.20.0\n",
    });
    expect(findCoreVersion(logs)).toMatchObject({
      version: "4.19.1",
      tag: "SDK_4.19.1",
    });
  });

  it("无 core version 行 → undefined", async () => {
    const logs = await makeLogs({ "a.log": "nothing here\n" });
    expect(findCoreVersion(logs)).toBeUndefined();
  });
});

describe("resolveRef（三级优先级）", () => {
  it("第一级：叙述显式 ref 优先于 versions 与 core version", async () => {
    const logs = await makeLogs({ "a.log": "core version: 4.19.1\n" });
    const result = resolveRef({
      narrative: "分支信息：msync",
      versions: ["4.19.1"],
      logFiles: logs,
    });
    expect(result).toEqual({
      ok: true,
      selection: { ref: "msync", source: "工单叙述显式指定" },
    });
  });

  it("第二级：唯一受影响版本 → SDK_ 标签（归一化）", async () => {
    const result = resolveRef({
      narrative: "登录失败",
      versions: ["SDK 4.19.1"],
      logFiles: [],
    });
    expect(result).toEqual({
      ok: true,
      selection: { ref: "SDK_4.19.1", source: "Jira 受影响版本：SDK 4.19.1" },
    });
  });

  it("第二级：重复值按 tag 去重后唯一 → 选中（同 tag 后者覆盖前者，log-bot 同款 Map 语义）", async () => {
    const result = resolveRef({
      narrative: "",
      versions: ["4.19.1", "SDK_4.19.1"],
      logFiles: [],
    });
    expect(result).toEqual({
      ok: true,
      selection: { ref: "SDK_4.19.1", source: "Jira 受影响版本：SDK_4.19.1" },
    });
  });

  it("多候选 + core version 消歧：恰一个命中 → 选中该版本", async () => {
    const logs = await makeLogs({ "a.log": "core version: 4.19.1\n" });
    const result = resolveRef({
      narrative: "",
      versions: ["4.19.1", "4.20.0"],
      logFiles: logs,
    });
    expect(result).toEqual({
      ok: true,
      selection: {
        ref: "SDK_4.19.1",
        source: "Jira 受影响版本经日志 core version 消歧：4.19.1",
        coreVersion: "4.19.1",
      },
    });
  });

  it("多候选无法消歧 → fail 且带候选列表（不猜）", async () => {
    const result = resolveRef({
      narrative: "",
      versions: ["4.19.1", "4.20.0"],
      logFiles: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.candidates).toEqual(["4.19.1", "4.20.0"]);
      expect(result.reason).toContain("4.19.1");
      expect(result.reason).toContain("4.20.0");
    }
  });

  it("多候选 + core version 不在候选中 → 仍歧义 fail", async () => {
    const logs = await makeLogs({ "a.log": "core version: 4.18.0\n" });
    const result = resolveRef({
      narrative: "",
      versions: ["4.19.1", "4.20.0"],
      logFiles: logs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.candidates).toEqual(["4.19.1", "4.20.0"]);
    }
  });

  it("第三级：无显式 ref、无 versions → 日志 core version 兜底", async () => {
    const logs = await makeLogs({ "a.log": "core version: 4.19.1\n" });
    const result = resolveRef({ narrative: "", versions: [], logFiles: logs });
    expect(result).toEqual({
      ok: true,
      selection: {
        ref: "SDK_4.19.1",
        source: "日志 core version",
        coreVersion: "4.19.1",
      },
    });
  });

  it("fixVersions 绝不参与选 ref：接口不接受 fixVersions，仅 versions 为空 + 无其他线索 → fail", async () => {
    // 纪律由类型钉死：fixVersions（如 4.19.2，修复目标版本）没有入口进入本函数；
    // 即便工单只有 fixVersions，也视为无线索 → fail（绝不拿修复目标当检出依据）
    const result = resolveRef({ narrative: "", versions: [], logFiles: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.candidates).toEqual([]);
    }
  });

  it("全部无线索 → fail（候选为空）", async () => {
    const result = resolveRef({
      narrative: "登录失败",
      versions: [],
      logFiles: [],
    });
    expect(result).toEqual({
      ok: false,
      reason:
        "无法确定 SDK 源码 ref：工单叙述无显式分支/tag、Jira 无受影响版本、日志无 core version 行",
      candidates: [],
    });
  });
});
