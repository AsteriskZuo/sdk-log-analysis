import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  ingestAttachment,
  isSupportedAttachmentName,
  normalizeLogText,
} from "../src/log-ingest.js";
import { buildTar, buildZip } from "./fixtures.js";

let logsDir = "";

beforeEach(() => {
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-ingest-"));
});

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true });
});

describe("附件白名单（spec §7：.log/.txt/.zip/.gz/.tar.gz/.tgz/无扩展名）", () => {
  it.each([
    "app.log",
    "notes.TXT",
    "pack.zip",
    "single.gz",
    "bundle.tar.gz",
    "bundle.tgz",
    "noext",
  ])("放行 %s", (filename) => {
    expect(isSupportedAttachmentName(filename)).toBe(true);
  });

  it.each([
    "screenshot.png",
    "photo.jpg",
    "doc.pdf",
    "doc.docx",
    "movie.mp4",
    "archive.tar", // 裸 .tar 不在白名单（只有 .tar.gz/.tgz）
  ])("跳过 %s", (filename) => {
    expect(isSupportedAttachmentName(filename)).toBe(false);
  });
});

describe("编码归一（normalizeLogText）", () => {
  it("UTF-16LE（BOM）→ UTF-8，CRLF → LF", () => {
    const buffer = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("line1\r\nline2", "utf16le"),
    ]);
    expect(normalizeLogText(buffer)).toBe("line1\nline2");
  });

  it("UTF-16BE（BOM）→ UTF-8", () => {
    const le = Buffer.from("ok", "utf16le");
    const swapped = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      swapped[i] = le[i + 1];
      swapped[i + 1] = le[i];
    }
    const buffer = Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]);
    expect(normalizeLogText(buffer)).toBe("ok");
  });

  it("UTF-8 去 BOM、去 NUL、CR → LF", () => {
    const buffer = Buffer.from("\uFEFFa\u0000b\rc", "utf8");
    expect(normalizeLogText(buffer)).toBe("ab\nc");
  });
});

describe("原始文本附件（.log/.txt/无扩展名）", () => {
  it("落盘并归一化，file 为相对 logs 目录路径", () => {
    const result = ingestAttachment({
      logsDir,
      filename: "app.log",
      buffer: Buffer.from("a\r\nb"),
    });
    expect(result.files).toEqual([
      { file: "app.log", size: 4, source_attachment: "app.log" },
    ]);
    expect(result.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(logsDir, "app.log"), "utf8")).toBe("a\nb");
  });

  it("重名去重改名：第二个 app.log → app-1.log", () => {
    ingestAttachment({
      logsDir,
      filename: "app.log",
      buffer: Buffer.from("1"),
    });
    const result = ingestAttachment({
      logsDir,
      filename: "app.log",
      buffer: Buffer.from("2"),
    });
    expect(result.files[0]?.file).toBe("app-1.log");
    expect(fs.readFileSync(path.join(logsDir, "app.log"), "utf8")).toBe("1");
    expect(fs.readFileSync(path.join(logsDir, "app-1.log"), "utf8")).toBe("2");
  });
});

describe("zip 解包", () => {
  it("STORE + DEFLATE 条目都解开，非日志条目记 skipped，__MACOSX 忽略", () => {
    const zip = buildZip([
      { name: "a.log", data: Buffer.from("store-a"), method: 0 },
      { name: "b.txt", data: Buffer.from("deflate-b"), method: 8 },
      { name: "inner.png", data: Buffer.from("png"), method: 0 },
      { name: "__MACOSX/._a.log", data: Buffer.from("junk"), method: 0 },
    ]);
    const result = ingestAttachment({
      logsDir,
      filename: "pack.zip",
      buffer: zip,
    });
    expect(result.files.map((f) => f.file)).toEqual(["a.log", "b.txt"]);
    expect(result.files.every((f) => f.source_attachment === "pack.zip")).toBe(
      true,
    );
    expect(result.skipped).toEqual([
      { filename: "inner.png", reason: "unsupported-extension" },
    ]);
    expect(fs.readFileSync(path.join(logsDir, "a.log"), "utf8")).toBe(
      "store-a",
    );
    expect(fs.readFileSync(path.join(logsDir, "b.txt"), "utf8")).toBe(
      "deflate-b",
    );
  });

  it("zip-slip 条目名消毒：../evil.log → logsDir 内 evil.log", () => {
    const zip = buildZip([
      { name: "../evil.log", data: Buffer.from("x"), method: 0 },
    ]);
    const result = ingestAttachment({
      logsDir,
      filename: "evil.zip",
      buffer: zip,
    });
    expect(result.files[0]?.file).toBe("evil.log");
    expect(fs.existsSync(path.join(logsDir, "evil.log"))).toBe(true);
    expect(fs.existsSync(path.join(logsDir, "..", "evil.log"))).toBe(false);
  });

  it("包内无日志条目 → files 为空（合法，由调用方记 empty-log-package）", () => {
    const zip = buildZip([
      { name: "only.png", data: Buffer.from("png"), method: 0 },
    ]);
    const result = ingestAttachment({
      logsDir,
      filename: "images.zip",
      buffer: zip,
    });
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([
      { filename: "only.png", reason: "unsupported-extension" },
    ]);
  });
});

describe("gz / tar.gz 解包", () => {
  it("x.log.gz → gunzip 后落 x.log", () => {
    const result = ingestAttachment({
      logsDir,
      filename: "single.log.gz",
      buffer: zlib.gzipSync(Buffer.from("gz-body")),
    });
    expect(result.files).toEqual([
      { file: "single.log", size: 7, source_attachment: "single.log.gz" },
    ]);
    expect(fs.readFileSync(path.join(logsDir, "single.log"), "utf8")).toBe(
      "gz-body",
    );
  });

  it("去 .gz 后非文本名 → 补 .log 后缀", () => {
    const result = ingestAttachment({
      logsDir,
      filename: "data.bin.gz",
      buffer: zlib.gzipSync(Buffer.from("raw")),
    });
    expect(result.files[0]?.file).toBe("data.bin.log");
  });

  it("tar.gz：gunzip + tar 解析，子目录条目保留相对结构，非日志条目记 skipped", () => {
    const tar = buildTar([
      { name: "sub/t.log", data: Buffer.from("tar-t") },
      { name: "img.png", data: Buffer.from("png") },
    ]);
    const result = ingestAttachment({
      logsDir,
      filename: "bundle.tar.gz",
      buffer: zlib.gzipSync(tar),
    });
    expect(result.files.map((f) => f.file)).toEqual(["sub/t.log"]);
    expect(result.skipped).toEqual([
      { filename: "img.png", reason: "unsupported-extension" },
    ]);
    expect(fs.readFileSync(path.join(logsDir, "sub", "t.log"), "utf8")).toBe(
      "tar-t",
    );
  });

  it("损坏的 gz → 抛错（调用方记 ingest-failed）", () => {
    expect(() =>
      ingestAttachment({
        logsDir,
        filename: "broken.gz",
        buffer: Buffer.from("not-a-gzip"),
      }),
    ).toThrow();
  });
});

describe("限额缺省值（spec §7：20MB / 100MB）", () => {
  it("常量", () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(20 * 1024 * 1024);
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(100 * 1024 * 1024);
  });
});
