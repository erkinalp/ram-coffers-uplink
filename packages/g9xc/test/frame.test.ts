import { describe, expect, it } from "vitest";
import {
  decodeHeader,
  encodeFrame,
  FrameReader,
  G9xcError,
  HEADER_SIZE,
  MAX_PAYLOAD,
  MSG_ERROR,
  MSG_PING,
  MSG_PONG,
  VERSION,
} from "../src/index.js";

function frame(msgType: number, payload: Uint8Array = new Uint8Array(0)) {
  return encodeFrame({
    msgType,
    requestId: 7,
    layer: 3,
    expert: 4,
    token: 11,
    dtype: 0,
    rank: 1,
    flags: 0,
    payload,
  });
}

describe("G9XC framing", () => {
  it("writes the 32-byte header fields in little-endian", () => {
    const raw = frame(MSG_PING, new Uint8Array([1, 2, 3]));
    expect(raw.length).toBe(HEADER_SIZE + 3);
    expect(new TextDecoder().decode(raw.subarray(0, 4))).toBe("G9XC");
    const view = new DataView(raw.buffer);
    expect(view.getUint8(4)).toBe(VERSION);
    expect(view.getUint8(5)).toBe(MSG_PING);
    expect(view.getUint32(8, true)).toBe(7);
    expect(view.getUint16(12, true)).toBe(3);
    expect(view.getUint16(14, true)).toBe(4);
    expect(view.getUint32(16, true)).toBe(11);
    expect(view.getUint32(24, true)).toBe(3);
    expect(view.getUint32(28, true)).toBe(0);
  });

  it("round-trips a header", () => {
    const raw = frame(MSG_ERROR, new TextEncoder().encode("boom"));
    const { frame: decoded, payloadLength } = decodeHeader(raw.subarray(0, HEADER_SIZE));
    expect(payloadLength).toBe(4);
    expect(decoded).toMatchObject({
      msgType: MSG_ERROR,
      requestId: 7,
      layer: 3,
      expert: 4,
      token: 11,
    });
  });

  it("rejects bad magic, a foreign version and unknown types", () => {
    const raw = frame(MSG_PING);
    const corrupted = new Uint8Array(raw);
    corrupted[0] = 0x58;
    expect(() => decodeHeader(corrupted)).toThrow(G9xcError);
    const wrongVersion = new Uint8Array(raw);
    wrongVersion[4] = 9;
    expect(() => decodeHeader(wrongVersion)).toThrow(/version 9/);
    expect(() => frame(99)).toThrow(/unknown message type/);
    const unknownType = new Uint8Array(raw);
    unknownType[5] = 99;
    expect(() => decodeHeader(unknownType)).toThrow(/unknown message type/);
  });

  it("refuses an oversized declared payload before allocating it", () => {
    const raw = frame(MSG_PING);
    const view = new DataView(raw.buffer);
    view.setUint32(24, MAX_PAYLOAD + 1, true);
    expect(() => decodeHeader(raw)).toThrow(/exceeds the limit/);
  });

  it("reassembles frames split mid-header and mid-payload", () => {
    const one = frame(MSG_PING, new Uint8Array([1, 2]));
    const two = frame(MSG_PONG, new Uint8Array([9, 8, 7]));
    const stream = new Uint8Array(one.length + two.length);
    stream.set(one, 0);
    stream.set(two, one.length);
    const reader = new FrameReader();
    expect(reader.push(stream.subarray(0, 5))).toEqual([]);
    expect(reader.push(stream.subarray(5, 33))).toEqual([]);
    const frames = reader.push(stream.subarray(33));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.msgType).toBe(MSG_PING);
    expect(frames[1]?.msgType).toBe(MSG_PONG);
    expect([...(frames[1]?.payload ?? [])]).toEqual([9, 8, 7]);
  });
});
