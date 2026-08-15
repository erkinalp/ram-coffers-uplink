import { describe, expect, it } from "vitest";
import {
  DTYPE_F32,
  decodeFrame,
  encodeFrame,
  FrameReader,
  MAX_FRAME_BYTES,
  MSG_REQ,
  P3xcError,
} from "../src/frame.js";
import { decodeFloat32BE, encodeFloat32BE } from "../src/tensor.js";

function reqFrame(values: number[], trailer = new Uint8Array(0)): Uint8Array {
  return encodeFrame({
    msgType: MSG_REQ,
    layer: 3,
    expert: 7,
    tokenId: 42,
    dtype: DTYPE_F32,
    shape: [values.length],
    payload: encodeFloat32BE(values),
    trailer,
  });
}

describe("frame codec", () => {
  it("round-trips a request frame", () => {
    const framed = reqFrame([1, -2.5, 3.25]);
    const body = framed.subarray(4);
    const frame = decodeFrame(body);
    expect(frame.msgType).toBe(MSG_REQ);
    expect(frame.layer).toBe(3);
    expect(frame.expert).toBe(7);
    expect(frame.tokenId).toBe(42);
    expect(frame.shape).toEqual([3]);
    expect(Array.from(decodeFloat32BE(frame.payload))).toEqual([1, -2.5, 3.25]);
    expect(frame.trailer.length).toBe(0);
  });

  it("writes the header in the layout the Python codec expects", () => {
    const framed = reqFrame([1]);
    const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
    expect(view.getUint32(0)).toBe(framed.length - 4);
    expect(new TextDecoder().decode(framed.subarray(4, 8))).toBe("P3XC");
    expect(view.getUint8(8)).toBe(1); // version
    expect(view.getUint8(9)).toBe(MSG_REQ);
    expect(view.getUint16(10)).toBe(3); // layer
    expect(view.getUint16(12)).toBe(7); // expert
    expect(view.getUint32(14)).toBe(42); // token id
    expect(view.getUint8(18)).toBe(DTYPE_F32);
    expect(view.getUint8(19)).toBe(1); // ndim
    expect(view.getUint32(20)).toBe(1); // shape[0]
  });

  it("keeps a trailer verbatim", () => {
    const trailer = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = decodeFrame(reqFrame([0, 0], trailer).subarray(4));
    expect(Array.from(frame.trailer)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects bad magic, versions and truncation", () => {
    const body = reqFrame([1]).subarray(4).slice();
    const wrongMagic = body.slice();
    wrongMagic[0] = 0x50 + 1;
    expect(() => decodeFrame(wrongMagic)).toThrow(P3xcError);
    const wrongVersion = body.slice();
    wrongVersion[4] = 2;
    expect(() => decodeFrame(wrongVersion)).toThrow(/version mismatch/);
    expect(() => decodeFrame(body.subarray(0, body.length - 1))).toThrow(/truncated payload/);
    expect(() => decodeFrame(body.subarray(0, 4))).toThrow(/short frame/);
  });

  it("rejects a payload that does not match the shape", () => {
    expect(() =>
      encodeFrame({
        msgType: MSG_REQ,
        layer: 0,
        expert: 0,
        tokenId: 0,
        dtype: DTYPE_F32,
        shape: [4],
        payload: new Uint8Array(8),
      }),
    ).toThrow(/does not match shape/);
  });

  it("reassembles frames split across chunks", () => {
    const reader = new FrameReader();
    const a = reqFrame([1, 2]);
    const b = reqFrame([3]);
    const stream = new Uint8Array(a.length + b.length);
    stream.set(a, 0);
    stream.set(b, a.length);
    expect(reader.push(stream.subarray(0, 3))).toHaveLength(0);
    expect(reader.push(stream.subarray(3, a.length - 1))).toHaveLength(0);
    const frames = reader.push(stream.subarray(a.length - 1));
    expect(frames).toHaveLength(2);
    expect(Array.from(decodeFloat32BE(frames[0]?.payload as Uint8Array))).toEqual([1, 2]);
    expect(Array.from(decodeFloat32BE(frames[1]?.payload as Uint8Array))).toEqual([3]);
  });

  it("refuses an absurd length prefix instead of allocating", () => {
    const reader = new FrameReader();
    const bogus = new Uint8Array(4);
    new DataView(bogus.buffer).setUint32(0, MAX_FRAME_BYTES + 1);
    expect(() => reader.push(bogus)).toThrow(/refusing/);
  });
});
