/**
 * Cross-language compatibility with `gen9-cluster/gen9_cluster`, the
 * reference G9XC implementation: this codec has to be byte-identical to it,
 * so the tests feed frames both ways through the real Python module rather
 * than a mock.
 *
 * Skipped when that stack is not to hand: point `GEN9_CLUSTER_DIR` at a
 * ram-coffers checkout's `gen9-cluster` directory to run these, or keep one
 * beside this repository.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeHeader,
  encodeExpertBatch,
  encodeFrame,
  FLAG_FAST,
  FLAG_PER_EXPERT,
  G9xcClient,
  MSG_HELLO,
  parseExpertResult,
  parseHello,
} from "../src/index.js";

const GEN9_CLUSTER =
  process.env.GEN9_CLUSTER_DIR ??
  fileURLToPath(new URL("../../../../ram-coffers/gen9-cluster", import.meta.url));

function python(script: string, stdin?: Uint8Array): { stdout: Buffer } {
  const result = spawnSync("python3", ["-c", script], {
    cwd: GEN9_CLUSTER,
    input: stdin ? Buffer.from(stdin) : undefined,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`python3 failed: ${result.stderr?.toString() ?? result.error?.message}`);
  return { stdout: result.stdout };
}

const pythonAvailable = (() => {
  if (!existsSync(GEN9_CLUSTER)) return false;
  const probe = spawnSync("python3", ["-c", "import numpy, gen9_cluster"], { cwd: GEN9_CLUSTER });
  return probe.status === 0;
})();

const PRELUDE = [
  "import sys",
  "from gen9_cluster import protocol",
  "import numpy as np",
  "raw = sys.stdin.buffer.read()",
].join("\n");

describe.skipIf(!pythonAvailable)("G9XC interop with gen9_cluster", () => {
  it("encodes a frame whose header the Python decoder reads back", () => {
    const frame = encodeFrame({
      msgType: MSG_HELLO,
      requestId: 0xcafe,
      layer: 5,
      expert: 9,
      token: 1234,
      dtype: 0,
      rank: 1,
      flags: FLAG_FAST,
      payload: new Uint8Array([1, 2, 3]),
    });
    const { stdout } = python(
      `${PRELUDE}\n` +
        "frame, length = protocol.Frame.decode_header(raw[:32])\n" +
        "print(int(frame.msg_type), hex(frame.request_id), frame.layer, frame.expert,\n" +
        "      frame.token, int(frame.flags), length)",
      frame,
    );
    expect(stdout.toString().trim()).toBe("1 0xcafe 5 9 1234 8 3");
  });

  it("decodes a Python-encoded frame byte for byte", () => {
    const { stdout } = python(
      "from gen9_cluster import protocol\nimport sys\n" +
        "frame = protocol.Frame(msg_type=protocol.MsgType.EXPERT_RESULT,\n" +
        "    request_id=77, layer=3, expert=11, token=42,\n" +
        "    dtype=protocol.DType.FP32, rank=1,\n" +
        "    flags=protocol.Flags.PER_EXPERT, payload=b'ab')\n" +
        "sys.stdout.buffer.write(frame.encode())",
    );
    const { frame, payloadLength } = decodeHeader(new Uint8Array(stdout.subarray(0, 32)));
    expect(payloadLength).toBe(2);
    expect(frame).toMatchObject({
      msgType: 4,
      requestId: 77,
      layer: 3,
      expert: 11,
      token: 42,
      rank: 1,
    });
    expect(frame.flags & FLAG_PER_EXPERT).toBe(FLAG_PER_EXPERT);
    expect(new TextDecoder().decode(stdout.subarray(32))).toBe("ab");
  });

  it("encodes an expert batch the Python parser accepts verbatim", () => {
    const raw = encodeExpertBatch({
      layer: 3,
      expertIds: [11, 12],
      gates: [0.75, 0.25],
      token: 77,
      activation: [0.5, 0.25],
      batchId: 0xdeadbeefn,
      fast: true,
    });
    const { stdout } = python(
      `${PRELUDE}\n` +
        "frame, length = protocol.Frame.decode_header(raw[:32])\n" +
        "assert int(frame.msg_type) == int(protocol.MsgType.EXPERT_BATCH)\n" +
        "assert int(frame.flags) & int(protocol.Flags.FAST)\n" +
        "batch = protocol.ExpertBatchPayload.decode(raw[32:])\n" +
        "print(frame.layer, frame.expert, frame.token, batch.batch_id == 0xdeadbeef,\n" +
        "      list(batch.expert_ids), list(batch.gates), batch.activation.tolist())",
      raw,
    );
    expect(stdout.toString().trim()).toBe("3 11 77 True [11, 12] [0.75, 0.25] [0.5, 0.25]");
  });

  it("encodes a batch without a batch id exactly as Python expects", () => {
    const raw = encodeExpertBatch({
      layer: 0,
      expertIds: [4],
      gates: [1],
      activation: [1, 2, 3],
    });
    const { stdout } = python(
      `${PRELUDE}\n` +
        "batch = protocol.ExpertBatchPayload.decode(raw[32:])\n" +
        "print(batch.batch_id is None, list(batch.expert_ids), batch.activation.tolist())",
      raw,
    );
    expect(stdout.toString().trim()).toBe("True [4] [1.0, 2.0, 3.0]");
  });

  it("parses a per-expert rows payload produced by Python", () => {
    const { stdout } = python(
      "from gen9_cluster import protocol\nimport numpy as np, sys\n" +
        "rows = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)\n" +
        "frame = protocol.Frame(msg_type=protocol.MsgType.EXPERT_RESULT,\n" +
        "    request_id=5, layer=3, token=77, dtype=protocol.DType.FP32, rank=1,\n" +
        "    flags=protocol.Flags.PER_EXPERT | protocol.Flags.REPLAYED,\n" +
        "    payload=protocol.ExpertRowsPayload((11, 12), rows).encode())\n" +
        "sys.stdout.buffer.write(frame.encode())",
    );
    const { frame, payloadLength } = decodeHeader(new Uint8Array(stdout.subarray(0, 32)));
    const parsed = parseExpertResult(
      { ...frame, payload: new Uint8Array(stdout.subarray(32, 32 + payloadLength)) },
      { expertIds: [11, 12], fast: false },
    );
    expect(parsed.perExpert).toBe(true);
    expect(parsed.replayed).toBe(true);
    expect(parsed.experts).toEqual([11, 12]);
    expect([...(parsed.rows[0] as Float32Array)]).toEqual([1, 2]);
    expect([...(parsed.rows[1] as Float32Array)]).toEqual([3, 4]);
  });

  it("parses a collapsed FAST reply produced by Python", () => {
    const { stdout } = python(
      "from gen9_cluster import protocol\nimport numpy as np, sys\n" +
        "frame = protocol.Frame(msg_type=protocol.MsgType.EXPERT_RESULT,\n" +
        "    request_id=9, dtype=protocol.DType.FP32,\n" +
        "    flags=protocol.Flags.PARTIAL,\n" +
        "    payload=protocol.encode_vector(np.array([4.0, 6.0], np.float32)))\n" +
        "sys.stdout.buffer.write(frame.encode())",
    );
    const { frame, payloadLength } = decodeHeader(new Uint8Array(stdout.subarray(0, 32)));
    const parsed = parseExpertResult(
      { ...frame, payload: new Uint8Array(stdout.subarray(32, 32 + payloadLength)) },
      { expertIds: [11, 12], fast: true },
    );
    expect(parsed.perExpert).toBe(false);
    expect(parsed.experts).toEqual([]);
    expect([...(parsed.rows[0] as Float32Array)]).toEqual([4, 6]);
  });

  it("decodes a node hello produced by Python", () => {
    const { stdout } = python(
      "from gen9_cluster import protocol\nimport sys\n" +
        "hello = protocol.HelloPayload('ps5-003', 'ps5', 'vulkan', 'ps5-linux',\n" +
        "    weight_bytes=1234, fast_bytes=567, gemv_gflops=940.5)\n" +
        "sys.stdout.buffer.write(hello.encode())",
    );
    const hello = parseHello(new Uint8Array(stdout));
    expect(hello).toMatchObject({
      unitId: "ps5-003",
      sku: "ps5",
      backend: "vulkan",
      runtime: "ps5-linux",
      weightBytes: 1234n,
      fastBytes: 567n,
      protocolVersion: 2,
    });
    expect(hello.gemvGflops).toBeCloseTo(940.5);
  });

  it("agrees with Python on an error payload", () => {
    const { stdout } = python(
      "from gen9_cluster import protocol\nimport sys\n" +
        "frame = protocol.Frame(msg_type=protocol.MsgType.ERROR, request_id=4,\n" +
        "    payload=protocol.encode_error('shard not resident'))\n" +
        "sys.stdout.buffer.write(frame.encode())",
    );
    const { frame, payloadLength } = decodeHeader(new Uint8Array(stdout.subarray(0, 32)));
    expect(() =>
      parseExpertResult(
        { ...frame, payload: new Uint8Array(stdout.subarray(32, 32 + payloadLength)) },
        { expertIds: [1], fast: false },
      ),
    ).toThrow(/shard not resident/);
  });

  it("round-trips ping, hello and a batch against a Python node", async () => {
    // A minimal worker using the reference framing and payloads: PING ->
    // PONG echo, HELLO -> HELLO_ACK, EXPERT_BATCH -> ExpertRowsPayload with
    // the activation doubled per expert, so the reply exercises decode too.
    const worker = spawn(
      "python3",
      [
        "-c",
        [
          "import socket, struct, sys",
          "from gen9_cluster import protocol",
          "import numpy as np",
          "s = socket.socket()",
          "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
          "s.bind(('127.0.0.1', 0))",
          "s.listen(1)",
          "print(s.getsockname()[1], flush=True)",
          "conn, _ = s.accept()",
          "",
          "def read_exact(n):",
          "    buf = b''",
          "    while len(buf) < n:",
          "        chunk = conn.recv(n - len(buf))",
          "        if not chunk: raise EOFError",
          "        buf += chunk",
          "    return buf",
          "",
          "for _ in range(3):",
          "    head = read_exact(protocol.HEADER_SIZE)",
          "    frame, length = protocol.Frame.decode_header(head)",
          "    frame.payload = read_exact(length)",
          "    if frame.msg_type == protocol.MsgType.PING:",
          "        conn.sendall(protocol.Frame(protocol.MsgType.PONG,",
          "                     request_id=frame.request_id, payload=frame.payload).encode())",
          "    elif frame.msg_type == protocol.MsgType.HELLO:",
          "        hello = protocol.HelloPayload('ps5-009', 'ps5', 'vulkan', 'linux',",
          "                      weight_bytes=10, fast_bytes=5, gemv_gflops=1.0)",
          "        conn.sendall(protocol.Frame(protocol.MsgType.HELLO_ACK,",
          "                     request_id=frame.request_id, payload=hello.encode()).encode())",
          "    else:",
          "        batch = protocol.ExpertBatchPayload.decode(frame.payload)",
          "        out = np.stack([batch.activation * (i + 1)",
          "                        for i in range(len(batch.expert_ids))])",
          "        rows = protocol.ExpertRowsPayload(batch.expert_ids, out)",
          "        conn.sendall(protocol.Frame(protocol.MsgType.EXPERT_RESULT,",
          "                     request_id=frame.request_id, layer=frame.layer,",
          "                     flags=protocol.Flags.PER_EXPERT,",
          "                     payload=rows.encode()).encode())",
          "conn.close()",
        ].join("\n"),
      ],
      { cwd: GEN9_CLUSTER },
    );
    const port = await new Promise<number>((resolve, reject) => {
      worker.stdout.once("data", (data: Buffer) => resolve(Number.parseInt(data.toString(), 10)));
      worker.once("error", reject);
    });
    const client = new G9xcClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
    try {
      expect(await client.ping()).toBeGreaterThanOrEqual(0);
      const hello = await client.hello();
      expect(hello.unitId).toBe("ps5-009");
      const result = await client.dispatchBatch({
        layer: 2,
        expertIds: [5, 6],
        gates: [0.5, 0.5],
        token: 9,
        activation: [1.5, -2.5],
      });
      expect(result.perExpert).toBe(true);
      expect(result.experts).toEqual([5, 6]);
      expect([...(result.rows[0] as Float32Array)]).toEqual([1.5, -2.5]);
      expect([...(result.rows[1] as Float32Array)]).toEqual([3, -5]);
    } finally {
      client.close();
      worker.kill();
    }
  });
});
