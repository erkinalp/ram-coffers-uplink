/**
 * Subcluster BREQ/BRSP/BERR frames, a port of `ps3-cluster/ps3_cluster/batch.py`.
 *
 * A batched request carries the activation once plus a compact `(expert, gate)`
 * list. The default (exact) reply is one weighted contribution per expert, so a
 * layer can accumulate strictly in top-k order and stay bit-identical to the
 * flat dispatcher; the fast reply folds the experts into a single partial sum
 * and is only produced when the request asks for it.
 */

import {
  DTYPE_F32,
  encodeFrame,
  type Frame,
  MSG_BERR,
  MSG_BREQ,
  MSG_BRSP,
  NO_EXPERT,
  P3xcError,
} from "./frame.js";
import { decodeFloat32BE, decodeFloat32Rows, encodeFloat32BE } from "./tensor.js";

export const MAX_BATCH_ENTRIES = 1024;
export const MAX_STRING_BYTES = 512;
export const MAX_DEADLINE_MS = 3_600_000;
/** Bound on a request id; ids are opaque, but they must fit the wire field. */
export const MAX_REQUEST_ID = 0xffff_ffff_ffff_ffffn;

export const REQ_FLAG_FAST = 0x0001;
export const REQ_FLAG_REQUEST_ID = 0x0002;
export const RSP_FLAG_PER_EXPERT = 0x0001;
export const RSP_FLAG_REQUEST_ID = 0x0002;
const RSP_FLAG_MASK = RSP_FLAG_PER_EXPERT | RSP_FLAG_REQUEST_ID;

export const ERR_OK = 0;
export const ERR_UNKNOWN = 1;
export const ERR_UNKNOWN_EXPERT = 2;
export const ERR_NODE_UNREACHABLE = 3;
export const ERR_NODE_TIMEOUT = 4;
export const ERR_NODE_ERROR = 5;
export const ERR_NODE_DISCONNECTED = 6;
export const ERR_BAD_REQUEST = 7;
export const ERR_SHUTTING_DOWN = 8;
export const ERR_DEDUP_CAPACITY = 9;

export interface BatchEntry {
  expert: number;
  gate: number;
  replica?: number;
}

export interface BatchRequestInit {
  layer: number;
  tokenId: number;
  activation: ArrayLike<number>;
  entries: readonly BatchEntry[];
  deadlineMs?: number;
  fast?: boolean;
  requestId?: bigint;
}

export function encodeBatchRequest(init: BatchRequestInit): Uint8Array {
  const entries = init.entries;
  if (entries.length === 0) throw new P3xcError("batch request needs at least one entry");
  if (entries.length > MAX_BATCH_ENTRIES)
    throw new P3xcError(`${entries.length} entries exceeds ${MAX_BATCH_ENTRIES}`);
  const deadlineMs = init.deadlineMs ?? 0;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > MAX_DEADLINE_MS)
    throw new P3xcError(`deadlineMs ${deadlineMs} out of range`);
  let flags = init.fast ? REQ_FLAG_FAST : 0;
  const hasId = init.requestId !== undefined;
  if (hasId) {
    const requestId = init.requestId as bigint;
    if (requestId < 0n || requestId > MAX_REQUEST_ID)
      throw new P3xcError(`requestId ${requestId} out of range`);
    flags |= REQ_FLAG_REQUEST_ID;
  }
  const trailer = new Uint8Array(8 + (hasId ? 8 : 0) + entries.length * 8);
  const view = new DataView(trailer.buffer);
  view.setUint16(0, entries.length);
  view.setUint16(2, flags);
  view.setUint32(4, deadlineMs);
  let off = 8;
  if (hasId) {
    view.setBigUint64(off, init.requestId as bigint);
    off += 8;
  }
  const seen = new Set<number>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.expert) || entry.expert < 0 || entry.expert > 0xffff)
      throw new P3xcError(`expert ${entry.expert} out of range`);
    const replica = entry.replica ?? 0;
    if (!Number.isInteger(replica) || replica < 0 || replica > 0xff)
      throw new P3xcError(`replica ${replica} out of range`);
    if (seen.has(entry.expert))
      throw new P3xcError(`expert ${entry.expert} appears twice in one batch`);
    seen.add(entry.expert);
    view.setUint16(off, entry.expert);
    view.setUint8(off + 2, replica);
    view.setUint8(off + 3, 0);
    view.setFloat32(off + 4, entry.gate);
    off += 8;
  }
  const payload = encodeFloat32BE(init.activation);
  return encodeFrame({
    msgType: MSG_BREQ,
    layer: init.layer,
    expert: NO_EXPERT,
    tokenId: init.tokenId,
    dtype: DTYPE_F32,
    shape: [init.activation.length],
    payload,
    trailer,
  });
}

export interface BatchResponse {
  layer: number;
  tokenId: number;
  nReduced: number;
  perExpert: boolean;
  experts: number[];
  /** One row per expert for an exact reply, a single row for a fast one. */
  contributions: Float32Array[];
  requestId: bigint | null;
}

export function parseBatchResponse(frame: Frame): BatchResponse {
  if (frame.msgType !== MSG_BRSP) throw new P3xcError(`expected BRSP, got ${frame.msgType}`);
  if (frame.dtype !== DTYPE_F32) throw new P3xcError("batch response must carry float32");
  const trailer = frame.trailer;
  if (trailer.length < 4) throw new P3xcError("batch response is missing its header");
  const view = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength);
  const nReduced = view.getUint16(0);
  const flags = view.getUint16(2);
  if (flags & ~RSP_FLAG_MASK) throw new P3xcError(`unsupported batch flags ${flags}`);
  if (nReduced === 0) throw new P3xcError("batch response reduced no experts");
  if (nReduced > MAX_BATCH_ENTRIES)
    throw new P3xcError(`nReduced ${nReduced} exceeds ${MAX_BATCH_ENTRIES}`);
  const perExpert = Boolean(flags & RSP_FLAG_PER_EXPERT);
  const idSize = flags & RSP_FLAG_REQUEST_ID ? 8 : 0;
  const expected = 4 + (perExpert ? 2 * nReduced : 0) + idSize;
  if (trailer.length !== expected)
    throw new P3xcError(
      `batch response trailer is ${trailer.length} bytes, expected ${expected} ` +
        `for ${nReduced} contributions`,
    );
  const experts: number[] = [];
  let contributions: Float32Array[];
  if (perExpert) {
    for (let i = 0; i < nReduced; i++) experts.push(view.getUint16(4 + 2 * i));
    if (new Set(experts).size !== experts.length)
      throw new P3xcError("an expert is tagged twice in one response");
    if (frame.shape.length < 2 || frame.shape[0] !== nReduced)
      throw new P3xcError(`batch response array does not hold ${nReduced} contributions`);
    contributions = decodeFloat32Rows(frame.payload, frame.shape);
  } else {
    contributions = [decodeFloat32BE(frame.payload)];
  }
  const requestId = idSize ? view.getBigUint64(trailer.length - 8) : null;
  return {
    layer: frame.layer,
    tokenId: frame.tokenId,
    nReduced,
    perExpert,
    experts,
    contributions,
    requestId,
  };
}

export interface BatchFailure {
  expert: number;
  reason: number;
  nodeId: string;
}

export interface BatchError {
  code: number;
  failures: BatchFailure[];
  detail: string;
  requestId: bigint | null;
}

export function parseBatchError(frame: Frame): BatchError {
  if (frame.msgType !== MSG_BERR) throw new P3xcError(`expected BERR, got ${frame.msgType}`);
  const trailer = frame.trailer;
  if (trailer.length < 4) throw new P3xcError("batch error is missing its header");
  const view = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength);
  const code = view.getUint16(0);
  const nFailures = view.getUint16(2);
  if (nFailures > MAX_BATCH_ENTRIES)
    throw new P3xcError(`${nFailures} failures exceeds ${MAX_BATCH_ENTRIES}`);
  let off = 4;
  const failures: BatchFailure[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < nFailures; i++) {
    if (trailer.length < off + 6) throw new P3xcError("truncated batch failure list");
    const expert = view.getUint16(off);
    const reason = view.getUint16(off + 2);
    const nodeLength = view.getUint16(off + 4);
    off += 6;
    if (nodeLength > MAX_STRING_BYTES)
      throw new P3xcError(`node id of ${nodeLength} bytes exceeds ${MAX_STRING_BYTES}`);
    if (trailer.length < off + nodeLength) throw new P3xcError("truncated node id");
    failures.push({
      expert,
      reason,
      nodeId: decoder.decode(trailer.subarray(off, off + nodeLength)),
    });
    off += nodeLength;
  }
  if (trailer.length < off + 2) throw new P3xcError("batch error is missing its detail length");
  const detailLength = view.getUint16(off);
  off += 2;
  if (detailLength > MAX_STRING_BYTES)
    throw new P3xcError(`detail of ${detailLength} bytes exceeds ${MAX_STRING_BYTES}`);
  if (trailer.length < off + detailLength) throw new P3xcError("truncated detail");
  const detail = decoder.decode(trailer.subarray(off, off + detailLength));
  off += detailLength;
  // A peer that does not echo ids ends after its detail string; anything else
  // left over means the frame does not match this protocol version.
  const rest = trailer.length - off;
  if (rest !== 0 && rest !== 8)
    throw new P3xcError(`batch error has ${rest} trailing bytes, expected 0 or 8`);
  const requestId = rest === 8 ? view.getBigUint64(off) : null;
  return { code, failures, detail, requestId };
}
