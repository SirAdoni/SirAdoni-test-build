const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const MAX_ZIP_BYTES = 32 * 1024 * 1024;
// Engine exports can contain several files per agent/function. Keep the parser
// bounded without rejecting large archives produced by Marinara itself.
const MAX_ZIP_ENTRIES = 8_192;
const MAX_TEXT_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 16 * 1024 * 1024;

type ZipTextEntry = {
  path: string;
  text: string;
};

type ZipCentralDirectoryEntry = {
  localHeaderOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  crc32: number;
  filename: string;
};

function readUint16(bytes: Uint8Array, offset: number) {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function findEndOfCentralDirectory(bytes: Uint8Array) {
  const minimumOffset = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset--) {
    if (readUint32(bytes, offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

export function isZipFile(file: File) {
  const name = file.name.toLowerCase();
  return name.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

export async function readTextFilesFromZip(file: File): Promise<ZipTextEntry[]> {
  const { bytes, entries } = await readZipCentralDirectory(file);
  const textEntries: ZipTextEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!isPackageTextPath(entry.filename)) continue;
    if (entry.uncompressedSize > MAX_TEXT_ENTRY_BYTES) throw new Error(`Zip entry ${entry.filename} is too large.`);
    const { text, byteLength } = await readZipTextEntry(
      bytes,
      entry,
      Math.min(MAX_TEXT_ENTRY_BYTES, MAX_TOTAL_TEXT_BYTES - totalBytes),
    );
    totalBytes += byteLength;
    if (totalBytes > MAX_TOTAL_TEXT_BYTES) throw new Error("Zip text content is too large.");
    textEntries.push({
      path: entry.filename.replace(/^\/+/, ""),
      text,
    });
  }
  return textEntries;
}

async function readZipCentralDirectory(file: File) {
  if (file.size > MAX_ZIP_BYTES) throw new Error("Zip file is too large.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const endOffset = findEndOfCentralDirectory(bytes);
  if (endOffset < 0) throw new Error("Invalid zip file");

  const entryCount = readUint16(bytes, endOffset + 10);
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error("Zip file contains too many entries.");
  const centralDirectoryOffset = readUint32(bytes, endOffset + 16);
  const decoder = new TextDecoder();
  const entries: ZipCentralDirectoryEntry[] = [];

  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > bytes.length) throw new Error("Invalid zip central directory");
    if (readUint32(bytes, offset) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER) {
      throw new Error("Invalid zip central directory");
    }

    const compressionMethod = readUint16(bytes, offset + 10);
    const crc32 = readUint32(bytes, offset + 16);
    const compressedSize = readUint32(bytes, offset + 20);
    const uncompressedSize = readUint32(bytes, offset + 24);
    const filenameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const localHeaderOffset = readUint32(bytes, offset + 42);
    const nextOffset = offset + 46 + filenameLength + extraLength + commentLength;
    if (nextOffset > bytes.length) throw new Error("Invalid zip central directory");
    const filename = decoder.decode(bytes.slice(offset + 46, offset + 46 + filenameLength));
    entries.push({ localHeaderOffset, compressedSize, uncompressedSize, compressionMethod, crc32, filename });

    offset = nextOffset;
  }

  return { bytes, entries };
}

async function readZipTextEntry(bytes: Uint8Array, entry: ZipCentralDirectoryEntry, maxBytes: number) {
  if (maxBytes <= 0) throw new Error("Zip text content is too large.");
  const headerOffset = entry.localHeaderOffset;
  if (readUint32(bytes, headerOffset) !== ZIP_LOCAL_FILE_HEADER) throw new Error("Invalid zip local file header");
  const filenameLength = readUint16(bytes, headerOffset + 26);
  const extraLength = readUint16(bytes, headerOffset + 28);
  const dataOffset = headerOffset + 30 + filenameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > bytes.length) throw new Error("Zip entry is truncated");
  const compressed = bytes.slice(dataOffset, dataEnd);
  let decoded: Uint8Array;
  if (entry.compressionMethod === 0) {
    if (compressed.byteLength > maxBytes) throw new Error(`Zip entry ${entry.filename} is too large.`);
    decoded = compressed;
  } else if (entry.compressionMethod === 8) {
    decoded = await inflateDeflateRaw(compressed, entry, maxBytes);
  } else {
    throw new Error(`Zip entry ${entry.filename} uses an unsupported compression method.`);
  }
  if (decoded.byteLength !== entry.uncompressedSize) {
    throw new Error(`Zip entry ${entry.filename} has an unexpected size.`);
  }
  if (crc32(decoded) !== entry.crc32) throw new Error(`Zip entry ${entry.filename} failed its checksum.`);
  return { text: new TextDecoder().decode(decoded), byteLength: decoded.byteLength };
}

async function inflateDeflateRaw(compressed: Uint8Array, entry: ZipCentralDirectoryEntry, maxBytes: number) {
  const ctor = (
    globalThis as {
      DecompressionStream?: new (format: string) => {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      };
    }
  ).DecompressionStream;
  if (!ctor) {
    throw new Error(`Zip entry ${entry.filename} is compressed; export it without compression before importing.`);
  }
  const compressedBuffer = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(compressedBuffer).set(compressed);
  const stream = new Blob([compressedBuffer]).stream().pipeThrough(new ctor("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Zip entry ${entry.filename} is too large.`);
    }
    chunks.push(value);
  }
  const inflated = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    inflated.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return inflated;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function isPackageTextPath(path: string) {
  const normalized = path.replace(/^\/+/, "").toLowerCase();
  if (!normalized || normalized.endsWith("/")) return false;
  return /\.(json|js|mjs|cjs|css|md|txt|ts|tsx)$/.test(normalized);
}
