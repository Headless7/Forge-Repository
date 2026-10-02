import { RobloxParseError } from "./model";

/**
 * LZ4 *block* decompression (no frame header), as used by Roblox binary chunks.
 * Bounds-checked: malformed input throws instead of reading past the buffers.
 */
export function lz4DecompressBlock(src: Uint8Array, outputLength: number): Uint8Array {
  const out = new Uint8Array(outputLength);
  let ip = 0;
  let op = 0;
  const end = src.length;

  const fail = () => {
    throw new RobloxParseError("Corrupt LZ4 chunk.");
  };

  while (ip < end) {
    const token = src[ip++]!;

    let literalLength = token >>> 4;
    if (literalLength === 15) {
      let b: number;
      do {
        if (ip >= end) fail();
        b = src[ip++]!;
        literalLength += b;
      } while (b === 255);
    }
    if (ip + literalLength > end || op + literalLength > outputLength) fail();
    out.set(src.subarray(ip, ip + literalLength), op);
    ip += literalLength;
    op += literalLength;

    // The last sequence has literals only.
    if (ip >= end) break;

    if (ip + 2 > end) fail();
    const offset = src[ip]! | (src[ip + 1]! << 8);
    ip += 2;
    if (offset === 0 || offset > op) fail();

    let matchLength = token & 15;
    if (matchLength === 15) {
      let b: number;
      do {
        if (ip >= end) fail();
        b = src[ip++]!;
        matchLength += b;
      } while (b === 255);
    }
    matchLength += 4;
    if (op + matchLength > outputLength) fail();

    let from = op - offset;
    if (offset >= matchLength) {
      out.copyWithin(op, from, from + matchLength);
      op += matchLength;
    } else {
      // Overlapping copy (run-length style) must go byte by byte.
      for (let i = 0; i < matchLength; i++) out[op++] = out[from++]!;
    }
  }

  if (op !== outputLength) fail();
  return out;
}
