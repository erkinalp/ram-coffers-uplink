import { describe, expect, it } from "vitest";
import {
  decodeMessage,
  decryptFrame,
  deriveSessionKeys,
  encodeMessage,
  encryptFrame,
  hashPsk,
  sha256Hex,
} from "../src/index.js";

const keys = deriveSessionKeys(
  hashPsk("test-psk"),
  new Uint8Array(16).fill(1),
  new Uint8Array(16).fill(2),
);
const aad = { sessionId: "session-1", direction: "s2r" as const, seq: 0 };
const plaintext = encodeMessage({ kind: "ping", ts: 42 });

describe("sha256Hex", () => {
  it("matches a known SHA-256 answer", () => {
    expect(sha256Hex("test")).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
  });
});

describe("deriveSessionKeys", () => {
  it("is deterministic (test vector)", () => {
    expect(Buffer.from(keys.s2r).toString("hex")).toMatchInlineSnapshot(
      `"a293b7a0437dc8ffdb9ad49e3c36353c0ef2351d28b37df3848498fe92687a5a"`,
    );
    expect(Buffer.from(keys.r2s).toString("hex")).toMatchInlineSnapshot(
      `"2549a699a09cac372153cffeafb789e86aa7b36f2d23414db65b013abe3ffdb8"`,
    );
  });

  it("derives different keys per direction", () => {
    expect(Buffer.from(keys.s2r).toString("hex")).not.toBe(Buffer.from(keys.r2s).toString("hex"));
  });
});

describe("frame codec", () => {
  it("roundtrips a frame", () => {
    const frame = encryptFrame(keys.s2r, aad, plaintext);
    expect(decodeMessage(decryptFrame(keys.s2r, aad, frame))).toEqual({ kind: "ping", ts: 42 });
  });

  it("rejects a tampered ciphertext", () => {
    const frame = encryptFrame(keys.s2r, aad, plaintext);
    frame[30] ^= 1;
    expect(() => decryptFrame(keys.s2r, aad, frame)).toThrow();
  });

  it("rejects the wrong key", () => {
    const other = deriveSessionKeys(
      hashPsk("other-psk"),
      new Uint8Array(16).fill(1),
      new Uint8Array(16).fill(2),
    );
    const frame = encryptFrame(keys.s2r, aad, plaintext);
    expect(() => decryptFrame(other.s2r, aad, frame)).toThrow();
  });

  it("rejects AAD mismatch (seq, direction, session)", () => {
    const frame = encryptFrame(keys.s2r, aad, plaintext);
    expect(() => decryptFrame(keys.s2r, { ...aad, seq: 1 }, frame)).toThrow();
    expect(() => decryptFrame(keys.r2s, { ...aad, direction: "r2s" }, frame)).toThrow();
    expect(() => decryptFrame(keys.s2r, { ...aad, sessionId: "other" }, frame)).toThrow();
  });

  it("rejects truncated frames", () => {
    expect(() => decryptFrame(keys.s2r, aad, new Uint8Array(10))).toThrow();
  });
});

describe("message codec", () => {
  it("rejects invalid frames", () => {
    expect(() => decodeMessage(encodeMessage({ kind: "ping", ts: 1 }))).not.toThrow();
    expect(() => decodeMessage(new TextEncoder().encode("not json"))).toThrow();
    expect(() => decodeMessage(new TextEncoder().encode("[1,2]"))).toThrow();
  });
});
