// Minimal ZIP reader for the Binance Vision archives (one CSV per zip, stored or deflated), using
// only node:zlib so the bot keeps its small dependency list. Reads the central directory, so data
// descriptors and zip64-free archives up to 4 GB work.

import zlib from 'zlib';

export interface ZipEntry { name: string; data: Buffer }

export function unzip(buf: Buffer): ZipEntry[] {
  // End of central directory: signature 0x06054b50 within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error(`zip entry ${name}: unsupported compression method ${method}`);
  }
  return out;
}
