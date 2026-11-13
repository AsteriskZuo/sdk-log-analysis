import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";

/** 管道喂 mock 信封跑构建产物，返回 {code, stdout}（契约：结果在 stdout 最后一行 JSON） */
function run(stdin: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["dist/programs/jira-log-fetch.js"],
      {
        input: stdin,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, stdout: e.stdout ?? "" };
  }
}

function lastResult(stdout: string): {
  ok: boolean;
  reason?: string;
  output?: unknown;
} {
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

const VALID_CONFIG = {
  jira_url: "https://jira.example.com",
  username: "u",
  password: "p",
};

describe("jira-log-fetch 程序契约（input/config 非法 → sdk.fail）", () => {
  it("input 缺 issue_key → ok:false + exit 1", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: {},
        config: VALID_CONFIG,
        workspace: ".",
      }),
    );
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("issue_key");
  });

  it("issue_key 非字符串 → ok:false", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: { issue_key: 123 },
        config: VALID_CONFIG,
        workspace: ".",
      }),
    );
    expect(r.code).toBe(1);
    expect(lastResult(r.stdout).ok).toBe(false);
  });

  it("config 三键全缺 → ok:false，reason 列出全部缺项", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: { issue_key: "HIM-1" },
        config: {},
        workspace: ".",
      }),
    );
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("jira_url");
    expect(result.reason).toContain("username");
    expect(result.reason).toContain("password");
  });

  it("config 缺部分键 → reason 只列缺的那个", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: { issue_key: "HIM-1" },
        config: { jira_url: "https://jira.example.com", username: "u" },
        workspace: ".",
      }),
    );
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("password");
    expect(result.reason).not.toContain("jira_url");
  });

  it("max_file_mb 非正数 → ok:false 指名 max_file_mb", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: { issue_key: "HIM-1" },
        config: { ...VALID_CONFIG, max_file_mb: "abc" },
        workspace: ".",
      }),
    );
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("max_file_mb");
  });

  it("workspace_subdir 含 .. 逃逸 → ok:false", () => {
    const r = run(
      JSON.stringify({
        contract_version: "v1",
        input: { issue_key: "HIM-1", workspace_subdir: "../escape" },
        config: VALID_CONFIG,
        workspace: ".",
      }),
    );
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("workspace_subdir");
  });

  it("空 stdin（无注入）→ 非零退出", () => {
    const r = run("");
    expect(r.code).not.toBe(0);
  });
});
