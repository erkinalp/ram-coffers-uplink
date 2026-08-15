/** Helpers converting between host-order float arrays and big-endian payloads. */

import { DTYPE_F32, itemSize, P3xcError } from "./frame.js";

export function encodeFloat32BE(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i] as number);
  return out;
}

export function decodeFloat32BE(payload: Uint8Array): Float32Array {
  if (payload.length % 4 !== 0) throw new P3xcError("float32 payload is not a multiple of 4");
  const out = new Float32Array(payload.length / 4);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4);
  return out;
}

/** Split a `[rows, cols]` float32 payload into one array per row. */
export function decodeFloat32Rows(payload: Uint8Array, shape: readonly number[]): Float32Array[] {
  if (shape.length < 2) throw new P3xcError("expected a two-dimensional payload");
  const rows = shape[0] as number;
  const flat = decodeFloat32BE(payload);
  const cols = rows === 0 ? 0 : flat.length / rows;
  const out: Float32Array[] = [];
  for (let r = 0; r < rows; r++) out.push(flat.subarray(r * cols, (r + 1) * cols));
  return out;
}

export function payloadBytes(dtype: number, count: number): number {
  return count * itemSize(dtype);
}

export const F32 = DTYPE_F32;
