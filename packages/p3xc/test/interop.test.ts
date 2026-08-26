/**
 * Cross-language compatibility with `ps3-cluster/ps3_cluster`, the reference
 * P3XC implementation: this codec has to be byte-identical to it, so the tests
 * feed frames both ways through the real Python module rather than a mock.
 *
 * Skipped when that stack is not to hand: point `PS3_CLUSTER_DIR` at a
 * ram-coffers checkout's `ps3-cluster` directory to run these, or keep one
 * beside this repository.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DTYPE_F32,
  decodeFrame,
  encodeBatchRequest,
  encodeFrame,
  MSG_BREQ,
  MSG_REQ,
  NO_EXPERT,
  P3xcClient,
  parseBatchError,
  parseBatchResponse,
} from "../src/index.js";

const PS3_CLUSTER =
  process.env.PS3_CLUSTER_DIR ??
  fileURLToPath(new URL("../../../../ram-coffers/ps3-cluster", import.meta.url));

function python(script: string, stdin?: Uint8Array): { ok: boolean; stdout: Buffer } {
  const result = spawnSync("python3", ["-c", script], {
    cwd: PS3_CLUSTER,
    input: stdin ? Buffer.from(stdin) : undefined,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`python3 failed: ${result.stderr?.toString() ?? result.error?.message}`);
  return { ok: true, stdout: result.stdout };
}

const pythonAvailable = (() => {
  if (!existsSync(PS3_CLUSTER)) return false;
  const probe = spawnSync("python3", ["-c", "import numpy, ps3_cluster"], { cwd: PS3_CLUSTER });
  return probe.status === 0;
})();

const PRELUDE = [
  "import sys",
  "from ps3_cluster import protocol, batch",
  "import numpy as np",
  "raw = sys.stdin.buffer.read()",
].join("\n");

describe.skipIf(!pythonAvailable)("P3XC interop with ps3_cluster", () => {
  it("encodes a request frame that the Python decoder reads back", () => {
    const activation = Float32Array.from([1.5, -2.25, 0.125, 4]);
    const frame = encodeFrame({
      msgType: MSG_REQ,
      layer: 5,
      expert: 9,
      tokenId: 1234,
      dtype: DTYPE_F32,
      shape: [activation.length],
      payload: new Uint8Array(
        (() => {
          const buf = new Uint8Array(activation.length * 4);
          const view = new DataView(buf.buffer);
          for (const [i, v] of activation.entries()) view.setFloat32(i * 4, v);
          return buf;
        })(),
      ),
    });
    const { stdout } = python(
      `${PRELUDE}\n` +
        "msg = protocol.decode(raw[4:])\n" +
        "print(msg['msg_type'], msg['layer'], msg['expert'], msg['token_id'],\n" +
        "      [float(v) for v in msg['array']], len(msg['trailer']))",
      frame,
    );
    expect(stdout.toString().trim()).toBe("1 5 9 1234 [1.5, -2.25, 0.125, 4.0] 0");
  });

  it("decodes a Python-encoded response frame, length prefix included", () => {
    const { stdout } = python(
      "from ps3_cluster import protocol\nimport numpy as np, sys\n" +
        "arr = np.array([[1.0, 2.0], [3.0, 4.0]], dtype='>f4')\n" +
        "sys.stdout.buffer.write(protocol.encode(protocol.MSG_RSP, 2, 7, 42, arr, b'xy'))",
    );
    const frame = decodeFrame(new Uint8Array(stdout.subarray(4)));
    expect(frame.msgType).toBe(2);
    expect(frame.layer).toBe(2);
    expect(frame.expert).toBe(7);
    expect(frame.tokenId).toBe(42);
    expect(frame.shape).toEqual([2, 2]);
    expect(new TextDecoder().decode(frame.trailer)).toBe("xy");
  });

  it("encodes a batch request the Python parser accepts verbatim", () => {
    const frame = encodeBatchRequest({
      layer: 3,
      tokenId: 77,
      activation: [0.5, 0.25],
      entries: [
        { expert: 11, gate: 0.75 },
        { expert: 12, gate: 0.25, replica: 2 },
      ],
      deadlineMs: 1500,
      requestId: 0xdeadbeefn,
    });
    const { stdout } = python(
      `${PRELUDE}\n` +
        "msg = batch.decode_batch_request(raw[4:])\n" +
        "print(msg['layer'], msg['token_id'], msg['expert'], msg['deadline_ms'],\n" +
        "      msg['fast'], hex(msg['request_id']), [float(v) for v in msg['array']],\n" +
        "      [(e.expert, e.gate, e.replica) for e in msg['entries']])",
      frame,
    );
    expect(stdout.toString().trim()).toBe(
      "3 77 65535 1500 False 0xdeadbeef [0.5, 0.25] [(11, 0.75, 0), (12, 0.25, 2)]",
    );
  });

  it("parses exact and fast batch responses produced by Python", () => {
    const exact = python(
      "from ps3_cluster import batch\nimport numpy as np, sys\n" +
        "rows = [np.array([1.0, 2.0], np.float32), np.array([3.0, 4.0], np.float32)]\n" +
        "sys.stdout.buffer.write(\n" +
        "    batch.encode_batch_contributions(3, 77, rows, [11, 12], request_id=0xdeadbeef))",
    );
    const exactFrame = decodeFrame(new Uint8Array(exact.stdout.subarray(4)));
    const parsedExact = parseBatchResponse(exactFrame);
    expect(parsedExact.perExpert).toBe(true);
    expect(parsedExact.experts).toEqual([11, 12]);
    expect(parsedExact.nReduced).toBe(2);
    expect(parsedExact.requestId).toBe(0xdeadbeefn);
    expect([...(parsedExact.contributions[0] as Float32Array)]).toEqual([1, 2]);
    expect([...(parsedExact.contributions[1] as Float32Array)]).toEqual([3, 4]);

    const fast = python(
      "from ps3_cluster import batch\nimport numpy as np, sys\n" +
        "sys.stdout.buffer.write(\n" +
        "    batch.encode_batch_response(3, 77, np.array([4.0, 6.0], np.float32), 2))",
    );
    const parsedFast = parseBatchResponse(decodeFrame(new Uint8Array(fast.stdout.subarray(4))));
    expect(parsedFast.perExpert).toBe(false);
    expect(parsedFast.experts).toEqual([]);
    expect(parsedFast.requestId).toBeNull();
    expect([...(parsedFast.contributions[0] as Float32Array)]).toEqual([4, 6]);
  });

  it("parses a batch error with failures, detail and an echoed id", () => {
    const { stdout } = python(
      "from ps3_cluster import batch\nimport sys\n" +
        "failures = [batch.BatchFailure(expert=11, reason=batch.ERR_NODE_TIMEOUT,\n" +
        "                               node_id='ps3-07')]\n" +
        "sys.stdout.buffer.write(batch.encode_batch_error(3, 77, batch.ERR_NODE_ERROR,\n" +
        "                        failures, 'expert stalled', request_id=0xdeadbeef))",
    );
    const parsed = parseBatchError(decodeFrame(new Uint8Array(stdout.subarray(4))));
    expect(parsed.code).toBe(5);
    expect(parsed.failures).toEqual([{ expert: 11, reason: 4, nodeId: "ps3-07" }]);
    expect(parsed.detail).toBe("expert stalled");
    expect(parsed.requestId).toBe(0xdeadbeefn);
  });

  it("agrees with the Python fingerprint on the same logical batch", () => {
    const frame = encodeBatchRequest({
      layer: 1,
      tokenId: 2,
      activation: [1, 2, 3],
      entries: [{ expert: 4, gate: 0.5 }],
    });
    const { stdout } = python(
      `${PRELUDE}\n` +
        "msg = batch.decode_batch_request(raw[4:])\n" +
        "print(msg['msg_type'] == batch.MSG_BREQ, len(batch.batch_fingerprint(msg)))",
      frame,
    );
    expect(stdout.toString().trim()).toBe("True 32");
    expect(decodeFrame(new Uint8Array(frame.subarray(4))).msgType).toBe(MSG_BREQ);
    expect(decodeFrame(new Uint8Array(frame.subarray(4))).expert).toBe(NO_EXPERT);
  });

  it("round-trips ping and expert dispatch against a Python expert worker", async () => {
    // A minimal worker using the reference framing: PING -> PONG, REQ -> RSP
    // with the activation doubled, so the reply exercises decode as well.
    const worker = spawn(
      "python3",
      [
        "-c",
        [
          "import socket, sys",
          "from ps3_cluster import protocol",
          "import numpy as np",
          "s = socket.socket()",
          "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
          "s.bind(('127.0.0.1', 0))",
          "s.listen(1)",
          "print(s.getsockname()[1], flush=True)",
          "conn, _ = s.accept()",
          "recv = conn.recv",
          "for _ in range(2):",
          "    msg = protocol.read_frame(recv)",
          "    if msg['msg_type'] == protocol.MSG_PING:",
          "        conn.sendall(protocol.encode(protocol.MSG_PONG, msg['layer'],",
          "                     msg['expert'], msg['token_id'], msg['array']))",
          "    else:",
          "        out = np.ascontiguousarray(msg['array'] * 2, dtype=np.float32)",
          "        conn.sendall(protocol.encode(protocol.MSG_RSP, msg['layer'],",
          "                     msg['expert'], msg['token_id'], out))",
          "conn.close()",
        ].join("\n"),
      ],
      { cwd: PS3_CLUSTER },
    );
    const port = await new Promise<number>((resolve, reject) => {
      worker.stdout.once("data", (data: Buffer) => resolve(Number.parseInt(data.toString(), 10)));
      worker.once("error", reject);
    });
    const client = new P3xcClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
    try {
      expect(await client.ping()).toBeGreaterThanOrEqual(0);
      const output = await client.dispatchExpert({
        layer: 2,
        expert: 5,
        tokenId: 9,
        activation: [1.5, -2.5],
      });
      expect([...output]).toEqual([3, -5]);
    } finally {
      client.close();
      worker.kill();
    }
  });
});
