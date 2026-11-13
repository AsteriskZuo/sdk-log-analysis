import zlib from "node:zlib";

/** 构造最小 zip（只有本地文件头序列，无中央目录——log-ingest 的解析器只读本地文件头） */
export function buildZip(
  entries: { name: string; data: Buffer; method: 0 | 8 }[],
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed =
      entry.method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(entry.method, 8); // 0=STORE 8=DEFLATE
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0, 12); // mod date
    header.writeUInt32LE(0, 14); // crc32（解析器不校验）
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28); // extra length
    chunks.push(header, nameBytes, compressed);
  }
  return Buffer.concat(chunks);
}

/** 构造最小 tar（512 字节头 + 数据块对齐；解析器不校验 checksum），末尾两个零块 */
export function buildTar(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, "utf8");
    header.write("0000644", 100); // mode
    header.write("0000000", 108); // uid
    header.write("0000000", 116); // gid
    header.write(entry.data.length.toString(8).padStart(11, "0"), 124); // size（八进制）
    header.write("00000000000", 136); // mtime
    header.write("0", 156); // typeflag = 普通文件
    chunks.push(header, entry.data);
    const padding =
      Math.ceil(entry.data.length / 512) * 512 - entry.data.length;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
