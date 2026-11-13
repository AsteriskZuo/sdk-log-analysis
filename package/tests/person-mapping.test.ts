import { describe, expect, it } from "@jest/globals";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonLookup } from "../packages/person-mapping.js";

// person-mapping 从审查业务仓原样拷贝（含 tags 查询，F3 与 mentions 依赖）；
// 本测试钉住 F3 依赖的 tags 查询行为与拼音兜底，fixture 不读真实映射表。
async function makeLookup(people: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "person-mapping-"));
  const file = join(dir, "mapping.json");
  await writeFile(file, JSON.stringify({ people }), "utf8");
  return createPersonLookup(file);
}

describe("person-mapping（tags 查询 = F3 判据）", () => {
  it("按 email / username 查到 tags；无 tags → 空数组", async () => {
    const lookup = await makeLookup([
      {
        jiraUsername: "zhangsan",
        jiraEmail: "zhangsan@example.com",
        wecomUserid: "ZhangSan",
        wecomName: "张三",
        tags: ["sdk", "backend"],
      },
      {
        jiraUsername: "lisi",
        jiraEmail: "lisi@example.com",
        wecomUserid: "LiSi",
        wecomName: "李四",
      },
    ]);

    await expect(
      lookup.lookupPersonTags({ emailAddress: "zhangsan@example.com" }),
    ).resolves.toEqual(["sdk", "backend"]);
    await expect(
      lookup.lookupPersonTags({ name: "zhangsan" }),
    ).resolves.toEqual(["sdk", "backend"]);
    await expect(
      lookup.lookupPersonTags({ emailAddress: "lisi@example.com" }),
    ).resolves.toEqual([]);
  });

  it("查不到映射记录 → 空数组（F3 视为无标签跳过的判据）", async () => {
    const lookup = await makeLookup([]);
    await expect(
      lookup.lookupPersonTags({
        emailAddress: "nobody@example.com",
        name: "nobody",
      }),
    ).resolves.toEqual([]);
  });

  it("lookupWeComAccount：命中带 tags；未命中中文名 → 拼音全拼兜底 guessed", async () => {
    const lookup = await makeLookup([
      {
        jiraUsername: "zhangsan",
        jiraEmail: "zhangsan@example.com",
        wecomUserid: "ZhangSan",
        wecomName: "张三",
        tags: ["sdk"],
      },
    ]);

    await expect(
      lookup.lookupWeComAccount({ emailAddress: "zhangsan@example.com" }),
    ).resolves.toEqual({
      wecomUserid: "ZhangSan",
      wecomName: "张三",
      tags: ["sdk"],
    });
    const guessed = await lookup.lookupWeComAccount({ name: "薛飞" });
    expect(guessed).toEqual({
      wecomUserid: "XueFei",
      wecomName: "薛飞",
      guessed: true,
    });
    await expect(
      lookup.lookupWeComAccount({ name: "unknown-user" }),
    ).resolves.toBeUndefined();
  });
});
