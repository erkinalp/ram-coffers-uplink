/**
 * P3XC frame codec, a byte-for-byte port of `ps3-cluster/ps3_cluster/protocol.py`.
 *
 * Every frame is length-prefixed and fixed to network byte order, because a
 * peer may be a big-endian PS3 (Cell/OtherOS) or a little-endian x86 host.
 */

export const MAGIC = "P3XC";
export const VERSION = 1;

export const MSG_REQ = 1;
export const MSG_RSP = 2;
export const MSG_ERR = 3;
export const MSG_PING = 4;
export const MSG_PONG = 5;
export const MSG_BREQ = 6;
export const MSG_BRSP = 7;
export const MSG_BERR = 8;

export const DTYPE_F32 = 1;
export const DTYPE_F16 = 2;
export const DTYPE_BF16 = 3;
export const DTYPE_U8 = 4;

/** Matches the C worker's limit, so a bad length prefix cannot exhaust XDR RAM. */
export const MAX_FRAME_BYTES = 1 << 26;

/** `expert` field for frames addressing a subcluster rather than an expert. */
export const NO_EXPERT = 0xffff;

/** `!4sBBHHIBB`: magic, version, msg_type, layer, expert, token_id, dtype, ndim. */
const HEADER_BYTES = 16;

export class P3xcError extends Error {}

export interface Frame {
  msgType: number;
  layer: number;
  expert: number;
  tokenId: number;
  dtype: number;
  shape: number[];
  /** Payload exactly as it travelled: big-endian elements, C order. */
  payload: Uint8Array;
  trailer: Uint8Array;
}

const ITEM_SIZE: Record<number, number> = {
  [DTYPE_F32]: 4,
  [DTYPE_F16]: 2,
  [DTYPE_BF16]: 2,
  [DTYPE_U8]: 1,
};

export function itemSize(dtype: number): number {
  const size = ITEM_SIZE[dtype];
  if (size === undefined) throw new P3xcError(`unsupported dtype tag ${dtype}`);
  return size;
}

export function elementCount(shape: readonly number[]): number {
  let count = 1;
  for (const dim of shape) {
    if (!Number.isInteger(dim) || dim < 0 || dim > 0xffffffff)
      throw new P3xcError(`shape dimension ${dim} out of range`);
    count *= dim;
  }
  return count;
}

/** Serialise one frame, including its 4-byte length prefix. */
export function encodeFrame(frame: Omit<Frame, "trailer"> & { trailer?: Uint8Array }): Uint8Array {
  const trailer = frame.trailer ?? new Uint8Array(0);
  if (frame.shape.length > 255) throw new P3xcError("too many dimensions");
  const expected = elementCount(frame.shape) * itemSize(frame.dtype);
  if (frame.payload.length !== expected)
    throw new P3xcError(`payload of ${frame.payload.length} bytes does not match shape`);
  const bodyLength = HEADER_BYTES + 4 * frame.shape.length + frame.payload.length + trailer.length;
  if (bodyLength > MAX_FRAME_BYTES)
    throw new P3xcError(`frame of ${bodyLength} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`);
  const out = new Uint8Array(4 + bodyLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, bodyLength);
  out.set(new TextEncoder().encode(MAGIC), 4);
  view.setUint8(8, VERSION);
  view.setUint8(9, frame.msgType);
  view.setUint16(10, frame.layer);
  view.setUint16(12, frame.expert);
  view.setUint32(14, frame.tokenId);
  view.setUint8(18, frame.dtype);
  view.setUint8(19, frame.shape.length);
  let off = 4 + HEADER_BYTES;
  for (const dim of frame.shape) {
    view.setUint32(off, dim);
    off += 4;
  }
  out.set(frame.payload, off);
  off += frame.payload.length;
  out.set(trailer, off);
  return out;
}

/** Parse one frame body, without its length prefix. */
export function decodeFrame(body: Uint8Array): Frame {
  if (body.length < HEADER_BYTES) throw new P3xcError("short frame");
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const magic = new TextDecoder().decode(body.subarray(0, 4));
  if (magic !== MAGIC) throw new P3xcError("bad magic");
  const version = view.getUint8(4);
  if (version !== VERSION) throw new P3xcError(`version mismatch ${version}`);
  const msgType = view.getUint8(5);
  const layer = view.getUint16(6);
  const expert = view.getUint16(8);
  const tokenId = view.getUint32(10);
  const dtype = view.getUint8(14);
  const ndim = view.getUint8(15);
  let off = HEADER_BYTES;
  if (body.length < off + 4 * ndim) throw new P3xcError("truncated shape");
  const shape: number[] = [];
  for (let i = 0; i < ndim; i++) {
    shape.push(view.getUint32(off));
    off += 4;
  }
  const end = off + elementCount(shape) * itemSize(dtype);
  if (body.length < end) throw new P3xcError("truncated payload");
  return {
    msgType,
    layer,
    expert,
    tokenId,
    dtype,
    shape,
    payload: body.subarray(off, end),
    trailer: body.subarray(end),
  };
}

/** Incremental reassembler for a stream of length-prefixed frames. */
export class FrameReader {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    const frames: Frame[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const length = view.getUint32(0);
      if (length === 0 || length > MAX_FRAME_BYTES)
        throw new P3xcError(`refusing a ${length} byte frame`);
      if (this.buffer.length < 4 + length) break;
      frames.push(decodeFrame(this.buffer.slice(4, 4 + length)));
      this.buffer = this.buffer.slice(4 + length);
    }
    return frames;
  }
}
