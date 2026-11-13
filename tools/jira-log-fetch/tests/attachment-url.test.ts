import { describe, expect, it } from "@jest/globals";
import { resolveAttachmentUrl } from "../src/jira-client.js";

// resolveAttachmentUrl 纯函数单测（HIM-24170 实战缺陷：jira 附件 content 地址给 http，
// 服务端 301→https，下载链路 redirect:manual 不跟随 → invalid_response。
// 修复 = 同主机 http→https 升级；跨主机与其他形状的行为必须不变）。

describe("resolveAttachmentUrl（附件 content 地址解析）", () => {
  it("http content 地址 + https baseUrl 同主机 → 升级为 https（HIM-24170 实战形状）", () => {
    expect(
      resolveAttachmentUrl(
        "http://j1.private.easemob.com/secure/attachment/73958/x.log",
        "https://j1.private.easemob.com",
      ),
    ).toBe("https://j1.private.easemob.com/secure/attachment/73958/x.log");
  });

  it("http content 地址 + http baseUrl → 原样不升级（base 非 https 无升级依据）", () => {
    expect(
      resolveAttachmentUrl("http://jira.local/secure/attachment/1/x.log", "http://jira.local"),
    ).toBe("http://jira.local/secure/attachment/1/x.log");
  });

  it("http content 地址 + https baseUrl 跨主机 → 原样不升级（跨主机重定向仍不跟随）", () => {
    expect(
      resolveAttachmentUrl(
        "http://cdn.other.com/attachment/1/x.log",
        "https://j1.private.easemob.com",
      ),
    ).toBe("http://cdn.other.com/attachment/1/x.log");
  });

  it("https content 地址 → 原样返回", () => {
    expect(
      resolveAttachmentUrl(
        "https://j1.private.easemob.com/secure/attachment/1/x.log",
        "https://j1.private.easemob.com",
      ),
    ).toBe("https://j1.private.easemob.com/secure/attachment/1/x.log");
  });

  it("站点相对路径按 baseUrl 补全（baseUrl 尾部斜线归一）", () => {
    expect(resolveAttachmentUrl("/secure/attachment/1/x.log", "https://jira.local/")).toBe(
      "https://jira.local/secure/attachment/1/x.log",
    );
  });

  it("相对路径不带前导斜线也补全", () => {
    expect(resolveAttachmentUrl("secure/attachment/1/x.log", "https://jira.local")).toBe(
      "https://jira.local/secure/attachment/1/x.log",
    );
  });
});
