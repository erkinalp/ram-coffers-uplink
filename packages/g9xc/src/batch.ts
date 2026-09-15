/**
 * `ExpertBatchPayload` / `ExpertRowsPayload` — the load-bearing pair of the
 * G9XC exchange, ported from `gen9_cluster.protocol`.
 *
 * A batch names a *set* of experts plus their gate weights, because a console
 * holds dozens and a token routing into three of them must not cost three
 * round trips. The reply is one weighted row per expert, tagged — the
 * coordinator adds them in strict top-k order, which is what keeps the answer
 * invariant under replans. `FLAG_FAST` opts out of that for reply bandwidth.
 */

import {
  DTYPE_FP32,
  encodeFrame,
  FLAG_BACKPRESSURE,
  FLAG_FAST,
  FLAG_FROM_STORAGE,
  FLAG_PARTIAL,
  FLAG_PER_EXPERT,
  FLAG_REPLAYED,
  type Frame,
  G9xcError,
  MSG_ERROR,
  MSG_EXPERT_BATCH,
  MSG_EXPERT_RESULT,
} from "./frame.js";
import { decodeFloat32LE, encodeFloat32LE } from "./tensor.js";

/** The wire fields are u16 for counts/experts and u64 for the batch id. */
export const MAX_BATCH_EXPERTS = 0xffff;
export const MAX_BATCH_ID = 0xffff_ffff_ffff_ffffn;

export interface ExpertBatchInit {
  layer: number;
  expertIds: readonly number[];
  gates: readonly number[];
  token?: number;
  activation: ArrayLike<number>;
  /** The logical-batch id a retry reuses; the node's dedup cache keys on it. */
  batchId?: bigint;
  /** Ask the node to collapse its experts into one gate-weighted sum. */
  fast?: boolean;
}

/** The EXPERT_BATCH frame a coordinator sends. `requestId` stays 0 here — the
 * transport allocates it per connection. */
export function encodeExpertBatch(init: ExpertBatchInit): Uint8Array {
  const { expertIds, gates } = init;
  if (expertIds.length === 0) throw new G9xcError("expert batch names no experts");
  if (expertIds.length !== gates.length)
    throw new G9xcError("expert ids and gates must be the same length");
  if (expertIds.length > MAX_BATCH_EXPERTS)
    throw new G9xcError(`${expertIds.length} experts exceeds ${MAX_BATCH_EXPERTS}`);
  for (const id of expertIds)
    if (!Number.isInteger(id) || id < 0 || id > 0xffff)
      throw new G9xcError(`expert id ${id} out of range`);
  const hasId = init.batchId !== undefined;
  if (hasId) {
    const batchId = init.batchId as bigint;
    if (batchId < 0n || batchId > MAX_BATCH_ID)
      throw new G9xcError(`batchId ${batchId} is not a u64`);
  }
  const activation = encodeFloat32LE(init.activation);
  const nActivation = activation.length / 4;
  const payload = new Uint8Array(
    2 + 4 + 1 + (hasId ? 8 : 0) + expertIds.length * (2 + 4) + activation.length,
  );
  const view = new DataView(payload.buffer);
  let off = 0;
  view.setUint16(off, expertIds.length, true);
  off += 2;
  // The activation length is stated, not inferred: a truncated tail is
  // otherwise a well-formed batch with a shorter hidden state.
  view.setUint32(off, nActivation, true);
  off += 4;
  view.setUint8(off, hasId ? 1 : 0);
  off += 1;
  if (hasId) {
    view.setBigUint64(off, init.batchId as bigint, true);
    off += 8;
  }
  for (const id of expertIds) {
    view.setUint16(off, id, true);
    off += 2;
  }
  for (const gate of gates) {
    view.setFloat32(off, gate, true);
    off += 4;
  }
  payload.set(activation, off);
  return encodeFrame({
    msgType: MSG_EXPERT_BATCH,
    requestId: 0,
    layer: init.layer,
    expert: expertIds[0] as number,
    token: init.token ?? 0,
    dtype: DTYPE_FP32,
    rank: 1,
    flags: init.fast ? FLAG_FAST : 0,
    payload,
  });
}

export interface ExpertResult {
  /** The node's reply flags: `replayed`/`fromStorage`/`backpressure` surface
   * to the caller so slow layers can be explained rather than guessed at. */
  replayed: boolean;
  fromStorage: boolean;
  backpressure: boolean;
  /** Exact mode: one weighted row per expert, in the node's return order.
   * `experts` then tags each row. Fast mode: a single collapsed sum. */
  perExpert: boolean;
  experts: number[];
  rows: Float32Array[];
}

/**
 * Parse an EXPERT_RESULT reply. Enforces the two rules the protocol exists
 * for: a collapsed (`PARTIAL`) payload is only legal when the request asked
 * for `FAST`, and an exact reply must name exactly the experts it was asked.
 */
export function parseExpertResult(
  frame: Frame,
  expected: { expertIds: readonly number[]; fast: boolean },
): ExpertResult {
  if (frame.msgType === MSG_ERROR) throw new G9xcError(new TextDecoder().decode(frame.payload));
  if (frame.msgType !== MSG_EXPERT_RESULT)
    throw new G9xcError(`expected EXPERT_RESULT, got ${frame.msgType}`);
  const partial = Boolean(frame.flags & FLAG_PARTIAL);
  if (partial && !expected.fast)
    throw new G9xcError("a collapsed reply arrived for a batch that did not ask for FAST");
  const common = {
    replayed: Boolean(frame.flags & FLAG_REPLAYED),
    fromStorage: Boolean(frame.flags & FLAG_FROM_STORAGE),
    backpressure: Boolean(frame.flags & FLAG_BACKPRESSURE),
  };
  if (partial) {
    return { ...common, perExpert: false, experts: [], rows: [decodeFloat32LE(frame.payload)] };
  }
  if (!(frame.flags & FLAG_PER_EXPERT))
    throw new G9xcError("an expert result is neither per-expert rows nor a partial sum");
  const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.length);
  if (frame.payload.length < 6) throw new G9xcError("expert rows payload is too short");
  const nRows = view.getUint16(0, true);
  const width = view.getUint32(2, true);
  const needed = 6 + nRows * 2 + nRows * width * 4;
  if (frame.payload.length !== needed)
    throw new G9xcError(
      `expert rows payload declares ${nRows} rows of width ${width}, ` +
        `which needs ${needed} bytes; got ${frame.payload.length}`,
    );
  if (nRows === 0) throw new G9xcError("expert rows payload carries no rows");
  let off = 6;
  const experts: number[] = [];
  for (let i = 0; i < nRows; i++) {
    experts.push(view.getUint16(off, true));
    off += 2;
  }
  const flat = decodeFloat32LE(frame.payload.subarray(off));
  const rows: Float32Array[] = [];
  for (let r = 0; r < nRows; r++) rows.push(flat.subarray(r * width, (r + 1) * width));
  // A missing row is a missing term in the layer's sum — the tag set must
  // equal the asked set, whatever order the node returned them in.
  if (new Set(experts).size !== experts.length)
    throw new G9xcError("an expert is tagged twice in one result");
  const asked = new Set(expected.expertIds);
  if (experts.length !== asked.size || !experts.every((id) => asked.has(id)))
    throw new G9xcError("the returned expert set does not match the batch");
  return { ...common, perExpert: true, experts, rows };
}

/** Decode a node's HELLO_ACK payload (`HelloPayload`). */
export interface Hello {
  weightBytes: bigint;
  fastBytes: bigint;
  gemvGflops: number;
  protocolVersion: number;
  unitId: string;
  sku: string;
  backend: string;
  runtime: string;
}

export function parseHello(payload: Uint8Array): Hello {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (payload.length < 25) throw new G9xcError("hello payload is truncated");
  const weightBytes = view.getBigUint64(0, true);
  const fastBytes = view.getBigUint64(8, true);
  const gemvGflops = view.getFloat64(16, true);
  const protocolVersion = view.getUint8(24);
  const decoder = new TextDecoder();
  let off = 25;
  const strings: string[] = [];
  for (let i = 0; i < 4; i++) {
    if (payload.length < off + 2) throw new G9xcError("hello payload is truncated");
    const length = view.getUint16(off, true);
    off += 2;
    if (payload.length < off + length) throw new G9xcError("hello payload is truncated");
    strings.push(decoder.decode(payload.subarray(off, off + length)));
    off += length;
  }
  return {
    weightBytes,
    fastBytes,
    gemvGflops,
    protocolVersion,
    unitId: strings[0] as string,
    sku: strings[1] as string,
    backend: strings[2] as string,
    runtime: strings[3] as string,
  };
}
