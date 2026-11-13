/** 日志附件归一化（spec §7 步骤 3/4/5；规则移植自 log-bot Agent/src/log-ingestion.js，语义不变）：
 *  - 白名单：.log / .txt / .zip / .gz / .tar.gz / .tgz / 无扩展名（按原始文本日志处理）；
 *    MIME 只记录不作为判据；
 *  - 解包：zip（STORE + DEFLATE，按本地文件头顺序解析，跳过目录与 __MACOSX）、
 *    gz（gunzip 后按去掉 .gz 的名字处理，结果非文本名则补 .log）、tar.gz（gunzip + tar 块解析）；
 *  - 编码归一：UTF-16LE/BE（BOM 识别）与 UTF-8（去 BOM）统一转 UTF-8，去 NUL，CRLF/CR → LF；
 *  - 落盘：重名去重改名（-1/-2 后缀），路径消毒（去 .. 与 . 段，防 zip-slip）。
 *  与 log-bot 的差异：不抛 EmptyLogPackageError/UnsupportedLogPackageError——
 *  包内无日志不是错误（spec §7：空日志是合法成功），解压产物为空时 files 返回空数组，
 *  由调用方记 skipped；压缩包内非日志条目（zip 与 tar.gz 都记）进 skipped。
 *  损坏的压缩包（gunzip/inflate 抛错）向上抛出，由调用方记 skipped(ingest-failed)。 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** 单文件限额缺省 20MB（spec §7；config.max_file_mb 可覆盖） */
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 累计限额缺省 100MB（spec §7；config.max_total_mb 可覆盖） */
export const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** 归一化落盘的一条日志 */
export interface IngestedLogFile {
  /** 相对 logs 目录的路径（posix 分隔，如 "a.log" 或 "sub/a-1.log"） */
  file: string;
  /** 来源字节数（归一化前原始 buffer 大小） */
  size: number;
  /** 来源附件名（jira 附件原始文件名） */
  source_attachment: string;
}

/** 被跳过条目（附件级或压缩包内条目级） */
export interface SkippedItem {
  filename: string;
  reason: string;
}

/** 单个附件的归一化结果 */
export interface IngestResult {
  files: IngestedLogFile[];
  skipped: SkippedItem[];
}

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const TAR_BLOCK_SIZE = 512;

/** 文本日志名：.log / .txt / 无扩展名 */
function isSupportedTextName(filename: string): boolean {
  return /\.(log|txt)$/i.test(filename) || !path.posix.extname(filename);
}

/** 附件白名单（spec §7）：.log .txt .zip .gz .tar.gz .tgz 与无扩展名 */
export function isSupportedAttachmentName(filename: string): boolean {
  const value = filename.trim();
  return (
    value.length > 0 &&
    (/\.(log|txt|zip|gz|tgz)$/i.test(value) || !path.posix.extname(value))
  );
}

/** 相对路径消毒：反斜杠归一、去掉空段/. /.. （防 zip-slip），空结果兜底 upload.log */
function sanitizeRelativeName(filename: string): string {
  const normalized = String(filename || "upload.log")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return normalized || "upload.log";
}

/** 重名去重改名：a.log 被占 → a-1.log → a-2.log … */
function uniqueOutputPath(rootDir: string, relativeName: string): string {
  const safeRelative = sanitizeRelativeName(relativeName);
  const parsed = path.posix.parse(safeRelative);
  let candidate = path.join(rootDir, safeRelative);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(
      rootDir,
      parsed.dir,
      `${parsed.name}-${suffix}${parsed.ext}`,
    );
    suffix += 1;
  }
  return candidate;
}

/** 文本解码：UTF-16LE/BE 按 BOM 识别，其余按 UTF-8（去 BOM） */
function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1];
      swapped[index - 1] = buffer[index];
    }
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

/** 归一化为 UTF-8 文本：解码 + 去 NUL + 换行归一 LF */
export function normalizeLogText(buffer: Buffer): string {
  return decodeTextBuffer(buffer)
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n");
}

function writeNormalizedText(args: {
  logsDir: string;
  sourceName: string;
  buffer: Buffer;
  origin: string;
}): IngestedLogFile {
  const { logsDir, sourceName, buffer, origin } = args;
  const relativeName = sanitizeRelativeName(sourceName);
  const outputPath = uniqueOutputPath(logsDir, relativeName);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, normalizeLogText(buffer), "utf8");
  return {
    file: path.relative(logsDir, outputPath).split(path.sep).join("/"),
    size: buffer.byteLength,
    source_attachment: origin,
  };
}

interface TarEntry {
  name: string;
  buffer: Buffer;
}

/** 解析 tar 块（ustar prefix 拼接；只收普通文件条目） */
function parseTarEntries(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  for (let offset = 0; offset + TAR_BLOCK_SIZE <= buffer.length;) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((value) => value === 0)) break;

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const typeflag = header.subarray(156, 157).toString("utf8") || "0";
    const sizeText = header
      .subarray(124, 136)
      .toString("utf8")
      .replace(/\0.*$/, "")
      .trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const dataOffset = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataOffset + size;
    const fullName = prefix ? `${prefix}/${name}` : name;

    if (
      (typeflag === "0" || typeflag === "") &&
      fullName &&
      dataEnd <= buffer.length
    ) {
      entries.push({
        name: fullName,
        buffer: buffer.subarray(dataOffset, dataEnd),
      });
    }
    offset = dataOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return entries;
}

/** 解析 zip 本地文件头序列（STORE 原样 / DEFLATE 走 inflateRaw；跳过目录与 __MACOSX；
 *  解压后字节数与头部声明不一致的条目丢弃） */
function parseZipEntries(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== ZIP_LOCAL_FILE_HEADER) break;

    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (nameEnd > buffer.length || dataEnd > buffer.length) break;

    const name = buffer.subarray(nameStart, nameEnd).toString("utf8");
    const compressed = buffer.subarray(dataStart, dataEnd);
    if (!name.endsWith("/") && !name.includes("__MACOSX/")) {
      let content: Buffer | null = null;
      if (method === ZIP_METHOD_STORE) {
        content = compressed;
      } else if (method === ZIP_METHOD_DEFLATE) {
        content = zlib.inflateRawSync(compressed);
      }
      if (content && content.byteLength === uncompressedSize) {
        entries.push({ name, buffer: content });
      }
    }

    offset = dataEnd;
  }
  return entries;
}

function stripGzExtension(filename: string): string {
  if (/\.tgz$/i.test(filename)) return filename.replace(/\.tgz$/i, ".tar");
  return filename.replace(/\.gz$/i, "");
}

function isTarGzName(filename: string): boolean {
  return /\.(tar\.gz|tgz)$/i.test(filename);
}

function isZipName(filename: string): boolean {
  return /\.zip$/i.test(filename);
}

function isGzName(filename: string): boolean {
  return /\.gz$/i.test(filename);
}

/** 单个已下载附件的归一化入口：按扩展名分流（tar.gz / zip / gz / 原始文本），
 *  结果落盘 logsDir；包内无日志条目 → files 为空（合法，调用方记 empty-log-package）。
 *  调用前提：filename 已过 isSupportedAttachmentName 白名单。 */
export function ingestAttachment(args: {
  logsDir: string;
  filename: string;
  buffer: Buffer;
}): IngestResult {
  const { logsDir, filename, buffer } = args;
  fs.mkdirSync(logsDir, { recursive: true });
  const safeFilename = sanitizeRelativeName(filename || "upload.log");
  const files: IngestedLogFile[] = [];
  const skipped: SkippedItem[] = [];

  if (isTarGzName(safeFilename)) {
    const tarBuffer = zlib.gunzipSync(buffer);
    const entries = parseTarEntries(tarBuffer);
    for (const entry of entries) {
      if (!isSupportedTextName(entry.name)) {
        skipped.push({ filename: entry.name, reason: "unsupported-extension" });
        continue;
      }
      files.push(
        writeNormalizedText({
          logsDir,
          sourceName: entry.name,
          buffer: entry.buffer,
          origin: safeFilename,
        }),
      );
    }
  } else if (isZipName(safeFilename)) {
    const entries = parseZipEntries(buffer);
    for (const entry of entries) {
      if (!isSupportedTextName(entry.name)) {
        skipped.push({ filename: entry.name, reason: "unsupported-extension" });
        continue;
      }
      files.push(
        writeNormalizedText({
          logsDir,
          sourceName: entry.name,
          buffer: entry.buffer,
          origin: safeFilename,
        }),
      );
    }
  } else if (isGzName(safeFilename)) {
    const outputName = stripGzExtension(safeFilename);
    files.push(
      writeNormalizedText({
        logsDir,
        sourceName: isSupportedTextName(outputName)
          ? outputName
          : `${outputName}.log`,
        buffer: zlib.gunzipSync(buffer),
        origin: safeFilename,
      }),
    );
  } else {
    // 白名单内剩余形态：.log / .txt / 无扩展名 → 原始文本
    files.push(
      writeNormalizedText({
        logsDir,
        sourceName: safeFilename,
        buffer,
        origin: safeFilename,
      }),
    );
  }

  return { files, skipped };
}
