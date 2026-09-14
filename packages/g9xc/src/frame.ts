/**
 * G9XC v2 frame codec, a byte-for-byte port of
 * `gen9-cluster/gen9_cluster/protocol.py` in erkinalp/ram-coffers.
 *
 * Unlike P3XC, G9XC frames a fixed 32-byte header followed by exactly
 * `payload_len` bytes: a reader learns the length from the header, so there
 * is no delimiter scanning and no partial-parse state. The wire order is
 * little-endian — every console in a gen9 fleet is x86-64, so host order and
 * wire order agree.
 */

export const MAGIC = "G9XC";
export const VERSION = 2;

export const MSG_HELLO = 1;
export const MSG_HELLO_ACK = 2;
export const MSG_EXPERT_BATCH = 3;
export const MSG_EXPERT_RESULT = 4;
export const MSG_BLOCK_FWD = 5;
export const MSG_BLOCK_RESULT = 6;
export const MSG_LOAD_SHARD = 7;
export const MSG_LOAD_ACK = 8;
export const MSG_PING = 9;
export const MSG_PONG = 10;
export const MSG_STATUS = 11;
export const MSG_STATUS_REPLY = 12;
export const MSG_ERROR = 13;
export const MSG_SHUTDOWN = 14;

export const DTYPE_FP32 = 0;
export const DTYPE_FP16 = 1;
export const DTYPE_BF16 = 2;
/** FP8 E4M3 with one fp32 scale per 128 elements, as DeepSeek ships it. */
export const DTYPE_FP8_E4M3_B128 = 3;

/** Reply: a collapsed partial sum; legal on a `FAST` reply and only there. */
export const FLAG_PARTIAL = 1 << 0;
/** Reply: served from NVMe, not RAM — explains a slow layer. */
export const FLAG_FROM_STORAGE = 1 << 1;
/** Reply: the node is shedding load and would like fewer of these. */
export const FLAG_BACKPRESSURE = 1 << 2;
/** Request: collapse this batch into one gate-weighted sum. Opt-in. */
export const FLAG_FAST = 1 << 3;
/** Reply: the payload is `ExpertRowsPayload` — one tagged row per expert. */
export const FLAG_PER_EXPERT = 1 << 4;
/** Reply: served from the dedup cache; the experts did not run again. */
export const FLAG_REPLAYED = 1 << 5;

/** A corrupt length field must not be able to ask for all of memory. */
export const MAX_PAYLOAD = 64 * 1024 * 1024;
/** `struct <4sBBHIHHIBBHI4x`: 28 bytes of fields plus 4 of padding. */
export const HEADER_SIZE = 32;

const KNOWN_TYPES = new Set([
  MSG_HELLO,
  MSG_HELLO_ACK,
  MSG_EXPERT_BATCH,
  MSG_EXPERT_RESULT,
  MSG_BLOCK_FWD,
  MSG_BLOCK_RESULT,
  MSG_LOAD_SHARD,
  MSG_LOAD_ACK,
  MSG_PING,
  MSG_PONG,
  MSG_STATUS,
  MSG_STATUS_REPLY,
  MSG_ERROR,
  MSG_SHUTDOWN,
]);

export class G9xcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "G9xcError";
  }
}

export interface Frame {
  msgType: number;
  requestId: number;
  layer: number;
  expert: number;
  token: number;
  dtype: number;
  rank: number;
  flags: number;
  payload: Uint8Array;
}

/** Serialise one frame: the 32-byte header, then the payload. */
export function encodeFrame(frame: Omit<Frame, "payload"> & { payload?: Uint8Array }): Uint8Array {
  const payload = frame.payload ?? new Uint8Array(0);
  if (payload.length > MAX_PAYLOAD)
    throw new G9xcError(`payload of ${payload.length} bytes exceeds the ${MAX_PAYLOAD} byte limit`);
  if (!KNOWN_TYPES.has(frame.msgType)) throw new G9xcError(`unknown message type ${frame.msgType}`);
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint8(4, VERSION);
  view.setUint8(5, frame.msgType);
  view.setUint16(6, frame.flags, true);
  view.setUint32(8, frame.requestId, true);
  view.setUint16(12, frame.layer, true);
  view.setUint16(14, frame.expert, true);
  view.setUint32(16, frame.token, true);
  view.setUint8(20, frame.dtype);
  view.setUint8(21, frame.rank);
  // 22-23 reserved, 24-27 payload length, 28-31 padding — all zero by default.
  view.setUint32(24, payload.length, true);
  out.set(payload, HEADER_SIZE);
  return out;
}

/** Parse a 32-byte header, returning the frame metadata and payload length. */
export function decodeHeader(head: Uint8Array): { frame: Frame; payloadLength: number } {
  if (head.length !== HEADER_SIZE) throw new G9xcError(`header must be ${HEADER_SIZE} bytes`);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const magic = new TextDecoder().decode(head.subarray(0, 4));
  if (magic !== MAGIC) throw new G9xcError("bad magic; not a G9XC stream");
  const version = view.getUint8(4);
  if (version !== VERSION) throw new G9xcError(`unsupported G9XC version ${version}`);
  const msgType = view.getUint8(5);
  if (!KNOWN_TYPES.has(msgType)) throw new G9xcError(`unknown message type ${msgType}`);
  const payloadLength = view.getUint32(24, true);
  if (payloadLength > MAX_PAYLOAD)
    throw new G9xcError(`declared payload of ${payloadLength} bytes exceeds the limit`);
  return {
    frame: {
      msgType,
      requestId: view.getUint32(8, true),
      layer: view.getUint16(12, true),
      expert: view.getUint16(14, true),
      token: view.getUint32(16, true),
      dtype: view.getUint8(20),
      rank: view.getUint8(21),
      flags: view.getUint16(6, true),
      payload: new Uint8Array(0),
    },
    payloadLength,
  };
}

/**
 * Incremental reassembler for a G9XC stream: fixed header, then the payload.
 * Replies can arrive interleaved; matching by `request_id` is the caller's
 * job.
 */
export class FrameReader {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    const frames: Frame[] = [];
    for (;;) {
      if (this.buffer.length < HEADER_SIZE) break;
      const { frame, payloadLength } = decodeHeader(this.buffer.subarray(0, HEADER_SIZE));
      const total = HEADER_SIZE + payloadLength;
      if (this.buffer.length < total) break;
      frame.payload = this.buffer.slice(HEADER_SIZE, total);
      this.buffer = this.buffer.slice(total);
      frames.push(frame);
    }
    return frames;
  }
}
