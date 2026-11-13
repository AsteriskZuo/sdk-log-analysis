import { describe, expect, it } from "@jest/globals";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoRegistry, type RepoEntry } from "../packages/repos.js";

/** 写一份临时登记表 fixture，返回文件路径 */
async function writeRegistry(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repos-"));
  const filePath = join(dir, "repos.json");
  await writeFile(
    filePath,
    typeof content === "string" ? content : JSON.stringify(content),
    "utf8",
  );
  return filePath;
}

/** 合法单条目（各用例在此基础上覆盖非法字段） */
function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    key: "linux",
    url: "https://github.com/easemob/emclient-linux",
    mainline_ref: "msync",
    assignee_tag: "sdk",
    match: ["linux"],
    ...overrides,
  };
}

function validFile(repos: unknown[] = [validEntry()]) {
  return { version: 1, repos };
}

describe("loadRepoRegistry（默认锚点：包根 repos.json，spec §4.0 首版六仓）", () => {
  it("加载真实登记表：六仓、顺序即优先级（ios 最前、linux 最后）", () => {
    const registry = loadRepoRegistry();
    expect(registry.version).toBe(1);
    expect(registry.repos.map((entry) => entry.key)).toEqual([
      "ios",
      "android",
      "harmony",
      "flutter",
      "react-native",
      "linux",
    ]);
  });

  it("ios 条目字段与 spec §4.0 一致；account 缺省（公开仓匿名）", () => {
    const registry = loadRepoRegistry();
    const ios = registry.repos[0];
    expect(ios).toEqual({
      key: "ios",
      url: "https://github.com/easemob/emclient-ios",
      mainline_ref: "chatsdk",
      assignee_tag: "sdk",
      match: ["ios", "iphone", "ipad"],
    });
    expect(ios.account).toBeUndefined();
  });

  it("linux 条目带 notes（共享 C++ 核心定位信息）", () => {
    const registry = loadRepoRegistry();
    const linux = registry.repos.find((entry) => entry.key === "linux");
    expect(linux?.mainline_ref).toBe("msync");
    expect(linux?.notes).toContain("C++");
  });
});

describe("loadRepoRegistry（文件与 JSON 层校验）", () => {
  it("文件缺失 → 抛错（含路径与「必要输入」说明）", () => {
    expect(() => loadRepoRegistry("/tmp/nonexistent-repos.json")).toThrow(
      /仓库登记表读取失败.*nonexistent-repos\.json/,
    );
  });

  it("非法 JSON → 抛错（含「JSON 解析失败」）", async () => {
    const filePath = await writeRegistry("{ not json");
    expect(() => loadRepoRegistry(filePath)).toThrow(/JSON 解析失败/);
  });

  it("根节点非对象 → 抛错", async () => {
    const filePath = await writeRegistry([1, 2, 3]);
    expect(() => loadRepoRegistry(filePath)).toThrow(/根节点必须是对象/);
  });
});

describe("loadRepoRegistry（version 语义，spec §4.1）", () => {
  it("version 缺失/非 number → 抛错", async () => {
    const noVersion = await writeRegistry({ repos: [validEntry()] });
    expect(() => loadRepoRegistry(noVersion)).toThrow(/version/);

    const strVersion = await writeRegistry({
      version: "1",
      repos: [validEntry()],
    });
    expect(() => loadRepoRegistry(strVersion)).toThrow(/version/);
  });

  it("version 更大 → 抛错（提示升级业务包）", async () => {
    const filePath = await writeRegistry({
      version: 2,
      repos: [validEntry()],
    });
    expect(() => loadRepoRegistry(filePath)).toThrow(
      /高于当前支持.*升级业务包/,
    );
  });

  it("version 更小（0）→ 按 1 处理，正常加载", async () => {
    const filePath = await writeRegistry({
      version: 0,
      repos: [validEntry()],
    });
    const registry = loadRepoRegistry(filePath);
    expect(registry.version).toBe(1);
    expect(registry.repos).toHaveLength(1);
  });
});

describe("loadRepoRegistry（repos 数组与逐字段校验，spec §4.1）", () => {
  it("repos 缺失/非数组/空数组 → 抛错", async () => {
    const missing = await writeRegistry({ version: 1 });
    expect(() => loadRepoRegistry(missing)).toThrow(/repos/);

    const empty = await writeRegistry(validFile([]));
    expect(() => loadRepoRegistry(empty)).toThrow(/repos.*非空/);
  });

  it("条目非对象 → 抛错（含下标）", async () => {
    const filePath = await writeRegistry(validFile(["not-an-object"]));
    expect(() => loadRepoRegistry(filePath)).toThrow(/repos\[0\].*对象/);
  });

  it("key 缺失 → 抛错", async () => {
    const entry = validEntry();
    delete (entry as Record<string, unknown>).key;
    const filePath = await writeRegistry(validFile([entry]));
    expect(() => loadRepoRegistry(filePath)).toThrow(/repos\[0\].*key/);
  });

  it("key 含大写/下划线等非法字符 → 抛错（指明当前值）", async () => {
    const filePath = await writeRegistry(
      validFile([validEntry({ key: "Linux_SDK" })]),
    );
    expect(() => loadRepoRegistry(filePath)).toThrow(/key=Linux_SDK.*key 非法/);
  });

  it("key 重复 → 抛错（key 全表唯一）", async () => {
    const filePath = await writeRegistry(
      validFile([validEntry(), validEntry()]),
    );
    expect(() => loadRepoRegistry(filePath)).toThrow(/key "linux" 重复/);
  });

  it("url 缺失 → 抛错；非 http(s) → 抛错", async () => {
    const noUrl = validEntry();
    delete (noUrl as Record<string, unknown>).url;
    const missing = await writeRegistry(validFile([noUrl]));
    expect(() => loadRepoRegistry(missing)).toThrow(/key=linux.*url/);

    const badUrl = await writeRegistry(
      validFile([validEntry({ url: "git@github.com:easemob/emclient-linux" })]),
    );
    expect(() => loadRepoRegistry(badUrl)).toThrow(/url 必须是 http\(s\)/);
  });

  it("mainline_ref 缺失/空串 → 抛错", async () => {
    const entry = validEntry();
    delete (entry as Record<string, unknown>).mainline_ref;
    const filePath = await writeRegistry(validFile([entry]));
    expect(() => loadRepoRegistry(filePath)).toThrow(/key=linux.*mainline_ref/);

    const empty = await writeRegistry(
      validFile([validEntry({ mainline_ref: "" })]),
    );
    expect(() => loadRepoRegistry(empty)).toThrow(/mainline_ref/);
  });

  it("assignee_tag 缺失 → 抛错", async () => {
    const entry = validEntry();
    delete (entry as Record<string, unknown>).assignee_tag;
    const filePath = await writeRegistry(validFile([entry]));
    expect(() => loadRepoRegistry(filePath)).toThrow(/key=linux.*assignee_tag/);
  });

  it("match 缺失/空数组/含空串元素 → 抛错", async () => {
    const noMatch = validEntry();
    delete (noMatch as Record<string, unknown>).match;
    const missing = await writeRegistry(validFile([noMatch]));
    expect(() => loadRepoRegistry(missing)).toThrow(/key=linux.*match/);

    const empty = await writeRegistry(validFile([validEntry({ match: [] })]));
    expect(() => loadRepoRegistry(empty)).toThrow(/match/);

    const blankItem = await writeRegistry(
      validFile([validEntry({ match: ["linux", "  "] })]),
    );
    expect(() => loadRepoRegistry(blankItem)).toThrow(/match\[1\].*非空/);
  });

  it("match 归一化：大小写混合 + 首尾空白 → 加载后小写 trim", async () => {
    const filePath = await writeRegistry(
      validFile([validEntry({ match: [" Linux ", "EMClient"] })]),
    );
    const registry = loadRepoRegistry(filePath);
    expect(registry.repos[0].match).toEqual(["linux", "emclient"]);
  });

  it("account 非字符串/空串 → 抛错；合法 account 保留", async () => {
    const bad = await writeRegistry(validFile([validEntry({ account: 1 })]));
    expect(() => loadRepoRegistry(bad)).toThrow(/account/);

    const blank = await writeRegistry(validFile([validEntry({ account: "" })]));
    expect(() => loadRepoRegistry(blank)).toThrow(/account/);

    const good = await writeRegistry(
      validFile([validEntry({ account: "gh_asterisk" })]),
    );
    expect(loadRepoRegistry(good).repos[0].account).toBe("gh_asterisk");
  });

  it("notes 非字符串 → 抛错；缺省不带 notes 键", async () => {
    const bad = await writeRegistry(validFile([validEntry({ notes: 42 })]));
    expect(() => loadRepoRegistry(bad)).toThrow(/notes/);

    const filePath = await writeRegistry(validFile([validEntry()]));
    const entry: RepoEntry = loadRepoRegistry(filePath).repos[0];
    expect("notes" in entry).toBe(false);
  });
});
