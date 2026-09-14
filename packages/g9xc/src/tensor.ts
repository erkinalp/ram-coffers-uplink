/** Little-endian float32 helpers — G9XC's wire order is host order (x86-64). */

import { G9xcError } from "./frame.js";

export function encodeFloat32LE(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i] as number, true);
  return out;
}

export function decodeFloat32LE(payload: Uint8Array): Float32Array {
  if (payload.length % 4 !== 0) throw new G9xcError("float32 payload is not a multiple of 4");
  const out = new Float32Array(payload.length / 4);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}
