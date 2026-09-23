const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function updateCrc32State(state: number, chunk: Uint8Array): number {
  let crc = state >>> 0;
  for (const byte of chunk) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return crc >>> 0;
}

export function finishCrc32(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}

export function crc32Buffer(buffer: Uint8Array): number {
  return finishCrc32(updateCrc32State(0xffffffff, buffer));
}
