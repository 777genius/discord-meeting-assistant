const OGG_POLYNOMIAL = 0x04c1_1db7;

const table = new Uint32Array(256);
for (let index = 0; index < table.length; index += 1) {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit += 1) {
    value =
      (value & 0x8000_0000) === 0
        ? (value << 1) >>> 0
        : ((value << 1) ^ OGG_POLYNOMIAL) >>> 0;
  }
  table[index] = value;
}

export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    const lookup = ((crc >>> 24) ^ byte) & 0xff;
    crc = (((crc << 8) >>> 0) ^ (table[lookup] ?? 0)) >>> 0;
  }
  return crc;
}
