/**
 * Decoder for Roblox instance attributes (the AttributesSerialize blob), following
 * https://github.com/rojo-rbx/rbx-dom/blob/master/docs/attributes.md
 * Only JSON-friendly values are returned; unknown types stop decoding (the format
 * has no length prefix per value, so nothing after an unknown type can be trusted).
 */

export type AttributeValue = string | number | boolean | number[] | number[][] | null;

export function decodeAttributes(bytes: Uint8Array | undefined): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  if (!bytes || bytes.length < 4) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > bytes.length) throw new RangeError("attributes truncated");
  };
  const u8 = () => (need(1), bytes[pos++]!);
  const u16 = () => (need(2), (pos += 2), view.getUint16(pos - 2, true));
  const u32 = () => (need(4), (pos += 4), view.getUint32(pos - 4, true));
  const i32 = () => (need(4), (pos += 4), view.getInt32(pos - 4, true));
  const f32 = () => (need(4), (pos += 4), view.getFloat32(pos - 4, true));
  const f64 = () => (need(8), (pos += 8), view.getFloat64(pos - 8, true));
  const str = () => {
    const len = u32();
    need(len);
    const s = decoder.decode(bytes.subarray(pos, pos + len));
    pos += len;
    return s;
  };

  try {
    const count = u32();
    for (let i = 0; i < count && i < 4096; i++) {
      const name = str();
      const type = u8();
      let value: AttributeValue;
      switch (type) {
        case 0x02:
          value = str();
          break;
        case 0x03:
          value = u8() !== 0;
          break;
        case 0x04:
          value = i32();
          break;
        case 0x05:
          value = f32();
          break;
        case 0x06:
          value = f64();
          break;
        case 0x09:
          value = [f32(), i32()];
          break;
        case 0x0a:
          value = [f32(), i32(), f32(), i32()];
          break;
        case 0x0e:
          value = u32();
          break;
        case 0x0f:
          value = [f32(), f32(), f32()];
          break;
        case 0x10:
          value = [f32(), f32()];
          break;
        case 0x11:
          value = [f32(), f32(), f32()];
          break;
        case 0x14: {
          const p = [f32(), f32(), f32()];
          const id = u8();
          if (id === 0) for (let k = 0; k < 9; k++) f32();
          value = p;
          break;
        }
        case 0x15:
          str();
          value = u32();
          break;
        case 0x17: {
          const n = u32();
          const kps: number[][] = [];
          for (let k = 0; k < n && k < 1024; k++) {
            const envelope = f32();
            const time = f32();
            kps.push([time, f32(), envelope]);
          }
          value = kps;
          break;
        }
        case 0x19: {
          const n = u32();
          const kps: number[][] = [];
          for (let k = 0; k < n && k < 1024; k++) {
            f32();
            const time = f32();
            kps.push([time, f32(), f32(), f32()]);
          }
          value = kps;
          break;
        }
        case 0x1b:
          value = [f32(), f32()];
          break;
        case 0x1c:
          value = [f32(), f32(), f32(), f32()];
          break;
        case 0x21: {
          u16();
          u8();
          value = str();
          str();
          break;
        }
        default:
          return out;
      }
      out[name] = value;
    }
  } catch {
    // Truncated blob: keep whatever decoded cleanly.
  }
  return out;
}
