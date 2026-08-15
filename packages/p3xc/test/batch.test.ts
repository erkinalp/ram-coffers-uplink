import { describe, expect, it } from "vitest";
import {
  ERR_NODE_TIMEOUT,
  encodeBatchRequest,
  MAX_BATCH_ENTRIES,
  parseBatchError,
  parseBatchResponse,
  REQ_FLAG_FAST,
  REQ_FLAG_REQUEST_ID,
  RSP_FLAG_PER_EXPERT,
  RSP_FLAG_REQUEST_ID,
} from "../src/batch.js";
import {
  DTYPE_F32,
  decodeFrame,
  encodeFrame,
  MSG_BERR,
  MSG_BREQ,
  MSG_BRSP,
  NO_EXPERT,
  P3xcError,
} from "../src/frame.js";
import { decodeFloat32BE, encodeFloat32BE } from "../src/tensor.js";

function decode(framed: Uint8Array) {
  return decodeFrame(framed.subarray(4));
}

describe("batch requests", () => {
  it("carries the activation once plus the (expert, gate) list", () => {
    const framed = encodeBatchRequest({
      layer: 2,
      tokenId: 9,
      activation: [1, 2, 3, 4],
      entries: [
        { expert: 5, gate: 0.5 },
        { expert: 6, gate: 0.25, replica: 1 },
      ],
      deadlineMs: 750,
    });
    const frame = decode(framed);
    expect(frame.msgType).toBe(MSG_BREQ);
    expect(frame.expert).toBe(NO_EXPERT);
    expect(Array.from(decodeFloat32BE(frame.payload))).toEqual([1, 2, 3, 4]);
    const trailer = new DataView(
      frame.trailer.buffer,
      frame.trailer.byteOffset,
      frame.trailer.byteLength,
    );
    expect(trailer.getUint16(0)).toBe(2);
    expect(trailer.getUint16(2)).toBe(0);
    expect(trailer.getUint32(4)).toBe(750);
    expect(trailer.getUint16(8)).toBe(5);
    expect(trailer.getUint8(10)).toBe(0);
    expect(trailer.getFloat32(12)).toBeCloseTo(0.5);
    expect(trailer.getUint16(16)).toBe(6);
    expect(trailer.getUint8(18)).toBe(1);
  });

  it("sets the fast and request-id flags and places the id before the entries", () => {
    const frame = decode(
      encodeBatchRequest({
        layer: 0,
        tokenId: 1,
        activation: [0],
        entries: [{ expert: 1, gate: 1 }],
        fast: true,
        requestId: 0x0102030405060708n,
      }),
    );
    const trailer = new DataView(
      frame.trailer.buffer,
      frame.trailer.byteOffset,
      frame.trailer.byteLength,
    );
    expect(trailer.getUint16(2)).toBe(REQ_FLAG_FAST | REQ_FLAG_REQUEST_ID);
    expect(trailer.getBigUint64(8)).toBe(0x0102030405060708n);
    expect(trailer.getUint16(16)).toBe(1);
  });

  it("rejects empty, oversized and duplicated batches", () => {
    expect(() =>
      encodeBatchRequest({ layer: 0, tokenId: 0, activation: [0], entries: [] }),
    ).toThrow(/at least one entry/);
    const many = Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => ({
      expert: i,
      gate: 1,
    }));
    expect(() =>
      encodeBatchRequest({ layer: 0, tokenId: 0, activation: [0], entries: many }),
    ).toThrow(/exceeds/);
    expect(() =>
      encodeBatchRequest({
        layer: 0,
        tokenId: 0,
        activation: [0],
        entries: [
          { expert: 1, gate: 1 },
          { expert: 1, gate: 1 },
        ],
      }),
    ).toThrow(/twice/);
    expect(() =>
      encodeBatchRequest({
        layer: 0,
        tokenId: 0,
        activation: [0],
        entries: [{ expert: 1, gate: 1 }],
        deadlineMs: 3_600_001,
      }),
    ).toThrow(/deadlineMs/);
  });
});

function exactResponse(rows: number[][], experts: number[], requestId?: bigint): Uint8Array {
  const flat = rows.flat();
  const flags = RSP_FLAG_PER_EXPERT | (requestId === undefined ? 0 : RSP_FLAG_REQUEST_ID);
  const trailer = new Uint8Array(4 + 2 * experts.length + (requestId === undefined ? 0 : 8));
  const view = new DataView(trailer.buffer);
  view.setUint16(0, rows.length);
  view.setUint16(2, flags);
  for (const [i, expert] of experts.entries()) view.setUint16(4 + 2 * i, expert);
  if (requestId !== undefined) view.setBigUint64(trailer.length - 8, requestId);
  return encodeFrame({
    msgType: MSG_BRSP,
    layer: 1,
    expert: NO_EXPERT,
    tokenId: 4,
    dtype: DTYPE_F32,
    shape: [rows.length, (rows[0] as number[]).length],
    payload: encodeFloat32BE(flat),
    trailer,
  });
}

describe("batch responses", () => {
  it("parses an exact reply into one row per expert", () => {
    const response = parseBatchResponse(
      decode(
        exactResponse(
          [
            [1, 2],
            [3, 4],
          ],
          [11, 12],
          7n,
        ),
      ),
    );
    expect(response.perExpert).toBe(true);
    expect(response.nReduced).toBe(2);
    expect(response.experts).toEqual([11, 12]);
    expect(Array.from(response.contributions[1] as Float32Array)).toEqual([3, 4]);
    expect(response.requestId).toBe(7n);
  });

  it("parses a fast reply as a single partial sum", () => {
    const trailer = new Uint8Array(4);
    new DataView(trailer.buffer).setUint16(0, 3);
    const framed = encodeFrame({
      msgType: MSG_BRSP,
      layer: 1,
      expert: NO_EXPERT,
      tokenId: 4,
      dtype: DTYPE_F32,
      shape: [2],
      payload: encodeFloat32BE([9, 10]),
      trailer,
    });
    const response = parseBatchResponse(decode(framed));
    expect(response.perExpert).toBe(false);
    expect(response.nReduced).toBe(3);
    expect(response.experts).toEqual([]);
    expect(Array.from(response.contributions[0] as Float32Array)).toEqual([9, 10]);
  });

  it("rejects a reply whose row count contradicts its array", () => {
    const trailer = new Uint8Array(8);
    const view = new DataView(trailer.buffer);
    view.setUint16(0, 2);
    view.setUint16(2, RSP_FLAG_PER_EXPERT);
    view.setUint16(4, 1);
    view.setUint16(6, 2);
    const framed = encodeFrame({
      msgType: MSG_BRSP,
      layer: 1,
      expert: NO_EXPERT,
      tokenId: 4,
      dtype: DTYPE_F32,
      shape: [3, 1],
      payload: encodeFloat32BE([1, 2, 3]),
      trailer,
    });
    expect(() => parseBatchResponse(decode(framed))).toThrow(P3xcError);
  });
});

describe("batch errors", () => {
  it("parses failures, detail and an echoed request id", () => {
    const node = new TextEncoder().encode("ps3-04");
    const detail = new TextEncoder().encode("expert 12 timed out");
    const trailer = new Uint8Array(4 + 6 + node.length + 2 + detail.length + 8);
    const view = new DataView(trailer.buffer);
    view.setUint16(0, ERR_NODE_TIMEOUT);
    view.setUint16(2, 1);
    view.setUint16(4, 12);
    view.setUint16(6, ERR_NODE_TIMEOUT);
    view.setUint16(8, node.length);
    trailer.set(node, 10);
    let off = 10 + node.length;
    view.setUint16(off, detail.length);
    trailer.set(detail, off + 2);
    off += 2 + detail.length;
    view.setBigUint64(off, 99n);
    const framed = encodeFrame({
      msgType: MSG_BERR,
      layer: 1,
      expert: NO_EXPERT,
      tokenId: 4,
      dtype: DTYPE_F32,
      shape: [1],
      payload: encodeFloat32BE([0]),
      trailer,
    });
    const error = parseBatchError(decode(framed));
    expect(error.code).toBe(ERR_NODE_TIMEOUT);
    expect(error.failures).toEqual([{ expert: 12, reason: ERR_NODE_TIMEOUT, nodeId: "ps3-04" }]);
    expect(error.detail).toBe("expert 12 timed out");
    expect(error.requestId).toBe(99n);
  });
});
