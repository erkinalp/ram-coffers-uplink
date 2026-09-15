import { describe, expect, it } from "vitest";
import {
  decodeHeader,
  encodeExpertBatch,
  FLAG_FAST,
  FLAG_PARTIAL,
  FLAG_PER_EXPERT,
  type Frame,
  MSG_ERROR,
  MSG_EXPERT_BATCH,
  MSG_EXPERT_RESULT,
  parseExpertResult,
  parseHello,
} from "../src/index.js";

function rowsFrame(experts: number[], rows: number[][], flags: number = FLAG_PER_EXPERT): Frame {
  const width = rows[0]?.length ?? 0;
  const payload = new Uint8Array(6 + experts.length * 2 + rows.length * width * 4);
  const view = new DataView(payload.buffer);
  view.setUint16(0, experts.length, true);
  view.setUint32(2, width, true);
  let off = 6;
  for (const id of experts) {
    view.setUint16(off, id, true);
    off += 2;
  }
  for (const row of rows)
    for (const value of row) {
      view.setFloat32(off, value, true);
      off += 4;
    }
  return {
    msgType: MSG_EXPERT_RESULT,
    requestId: 1,
    layer: 0,
    expert: 0,
    token: 0,
    dtype: 0,
    rank: 1,
    flags,
    payload,
  };
}

describe("ExpertBatchPayload", () => {
  it("lays out counts, ids, gates and the activation in order", () => {
    const raw = encodeExpertBatch({
      layer: 5,
      expertIds: [9, 11],
      gates: [0.75, 0.25],
      token: 4,
      activation: [1.5, -2.25],
      batchId: 0xdeadbeefn,
    });
    const { frame } = decodeHeader(raw.subarray(0, 32));
    expect(frame.msgType).toBe(MSG_EXPERT_BATCH);
    const payload = raw.subarray(32);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    expect(view.getUint16(0, true)).toBe(2);
    expect(view.getUint32(2, true)).toBe(2);
    expect(view.getUint8(6)).toBe(1);
    expect(view.getBigUint64(7, true)).toBe(0xdeadbeefn);
    expect(view.getUint16(15, true)).toBe(9);
    expect(view.getUint16(17, true)).toBe(11);
    expect(view.getFloat32(19, true)).toBeCloseTo(0.75);
    expect(view.getFloat32(23, true)).toBeCloseTo(0.25);
    expect(view.getFloat32(27, true)).toBeCloseTo(1.5);
    expect(view.getFloat32(31, true)).toBeCloseTo(-2.25);
  });

  it("omits the batch id and sets FAST only when asked", () => {
    const raw = encodeExpertBatch({
      layer: 1,
      expertIds: [3],
      gates: [1],
      activation: [0],
      fast: true,
    });
    const { frame } = decodeHeader(raw.subarray(0, 32));
    expect(frame.flags).toBe(FLAG_FAST);
    const payload = raw.subarray(32);
    expect(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint8(6)).toBe(
      0,
    );
    expect(payload.length).toBe(2 + 4 + 1 + 2 + 4 + 4);
  });

  it("rejects mismatched or malformed inputs", () => {
    const base = { layer: 0, activation: [1] };
    expect(() => encodeExpertBatch({ ...base, expertIds: [], gates: [] })).toThrow(/no experts/);
    expect(() => encodeExpertBatch({ ...base, expertIds: [1], gates: [] })).toThrow(/same length/);
    expect(() => encodeExpertBatch({ ...base, expertIds: [0x1_0000], gates: [1] })).toThrow(
      /out of range/,
    );
    expect(() => encodeExpertBatch({ ...base, expertIds: [1], gates: [1], batchId: -1n })).toThrow(
      /u64/,
    );
  });
});

describe("ExpertRowsPayload parsing", () => {
  it("returns one tagged row per expert", () => {
    const frame = rowsFrame(
      [9, 11],
      [
        [1, 2],
        [3, 4],
      ],
    );
    const result = parseExpertResult(frame, { expertIds: [9, 11], fast: false });
    expect(result.perExpert).toBe(true);
    expect(result.experts).toEqual([9, 11]);
    expect([...(result.rows[0] as Float32Array)]).toEqual([1, 2]);
    expect([...(result.rows[1] as Float32Array)]).toEqual([3, 4]);
  });

  it("surfaces the node's flags", () => {
    const frame = rowsFrame([9], [[1]], FLAG_PER_EXPERT | 32 | 2);
    const result = parseExpertResult(frame, { expertIds: [9], fast: false });
    expect(result.replayed).toBe(true);
    expect(result.fromStorage).toBe(true);
    expect(result.backpressure).toBe(false);
  });

  it("rejects a collapsed reply that was never asked for", () => {
    const payload = new Uint8Array(8);
    const partialView = new DataView(payload.buffer);
    partialView.setFloat32(0, 0, true);
    partialView.setFloat32(4, 2.5, true);
    const frame: Frame = { ...rowsFrame([9], [[1]]), flags: FLAG_PARTIAL, payload };
    expect(() => parseExpertResult(frame, { expertIds: [9], fast: false })).toThrow(
      /did not ask for FAST/,
    );
  });

  it("accepts the partial sum a FAST batch asked for", () => {
    const payload = new Uint8Array(8);
    const partialView = new DataView(payload.buffer);
    partialView.setFloat32(0, 1.5, true);
    partialView.setFloat32(4, -0.5, true);
    const frame: Frame = { ...rowsFrame([9], [[1]]), flags: FLAG_PARTIAL, payload };
    const result = parseExpertResult(frame, { expertIds: [9], fast: true });
    expect(result.perExpert).toBe(false);
    expect([...(result.rows[0] as Float32Array)]).toEqual([1.5, -0.5]);
  });

  it("rejects a reply whose expert set does not match the batch", () => {
    const frame = rowsFrame([9, 12], [[1], [2]]);
    expect(() => parseExpertResult(frame, { expertIds: [9, 11], fast: false })).toThrow(
      /does not match/,
    );
  });

  it("rejects a truncated or empty rows payload", () => {
    const short = rowsFrame([9], [[1]]);
    short.payload = short.payload.subarray(0, 10);
    expect(() => parseExpertResult(short, { expertIds: [9], fast: false })).toThrow(/needs/);
    expect(() => parseExpertResult(rowsFrame([], []), { expertIds: [], fast: false })).toThrow(
      /no rows/,
    );
  });

  it("turns an ERROR frame into a raised message", () => {
    const frame: Frame = {
      ...rowsFrame([9], [[1]]),
      msgType: MSG_ERROR,
      payload: new TextEncoder().encode("shard not resident"),
    };
    expect(() => parseExpertResult(frame, { expertIds: [9], fast: false })).toThrow(
      /shard not resident/,
    );
  });
});

describe("HelloPayload", () => {
  it("decodes a node's self-announcement", () => {
    const strings = ["ps5-003", "ps5", "vulkan", "ps5-linux"];
    const body = new Uint8Array(25 + strings.reduce((n, s) => n + 2 + s.length, 0));
    const view = new DataView(body.buffer);
    view.setBigUint64(0, 1234n, true);
    view.setBigUint64(8, 567n, true);
    view.setFloat64(16, 940.5, true);
    view.setUint8(24, 2);
    let off = 25;
    for (const text of strings) {
      const raw = new TextEncoder().encode(text);
      view.setUint16(off, raw.length, true);
      off += 2;
      body.set(raw, off);
      off += raw.length;
    }
    const hello = parseHello(body);
    expect(hello).toMatchObject({
      weightBytes: 1234n,
      fastBytes: 567n,
      unitId: "ps5-003",
      sku: "ps5",
      backend: "vulkan",
      runtime: "ps5-linux",
      protocolVersion: 2,
    });
    expect(hello.gemvGflops).toBeCloseTo(940.5);
  });
});
