import http from "node:http";
import type { Responder } from "@ram-coffers-uplink/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchModels, forwardOverHttp } from "../src/coffer-http.js";

function mockResponder(): Responder & {
  head: ReturnType<typeof vi.fn>;
  chunks: string[];
  end: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  cancelCbs: Array<() => void>;
} {
  const r = {
    head: vi.fn(),
    chunks: [] as string[],
    end: vi.fn(),
    error: vi.fn(),
    cancelCbs: [] as Array<() => void>,
    sendHead(status: number, headers: Record<string, string>) {
      r.head(status, headers);
    },
    sendChunk(data: Uint8Array) {
      r.chunks.push(new TextDecoder().decode(data));
    },
    sendEnd(usage: unknown) {
      r.end(usage);
    },
    sendError(message: string) {
      r.error(message);
    },
    onCancel(cb: () => void) {
      r.cancelCbs.push(cb);
    },
  };
  return r as Responder & typeof r;
}

describe("http upstream forwarding", () => {
  let server: http.Server;
  let port: number;
  let handler: http.RequestListener;

  beforeEach(async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end("{}");
    };
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    port = address.port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const cofferUrl = (): string => `http://127.0.0.1:${port}`;

  it("forwards the request and streams chunks with usage from the final NDJSON line", async () => {
    handler = (req, res) => {
      expect(req.url).toBe("/api/generate");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        expect(JSON.parse(body)).toEqual({ model: "llama3" });
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write('{"response":"Hel"}\n');
        res.end('{"response":"lo","done":true,"prompt_eval_count":5,"eval_count":7}\n');
      });
    };
    const responder = mockResponder();
    await forwardOverHttp(
      cofferUrl(),
      {
        method: "POST",
        path: "/api/generate",
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ model: "llama3" })).toString("base64"),
      },
      responder,
    );
    expect(responder.head).toHaveBeenCalledWith(200, { "content-type": "application/x-ndjson" });
    expect(responder.chunks.join("")).toBe(
      '{"response":"Hel"}\n{"response":"lo","done":true,"prompt_eval_count":5,"eval_count":7}\n',
    );
    expect(responder.end).toHaveBeenCalledWith({ prompt_tokens: 5, completion_tokens: 7 });
  });

  it("extracts usage from OpenAI-style usage fields", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"choices":[]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":4}}\n\ndata: [DONE]\n\n',
      );
    };
    const responder = mockResponder();
    await forwardOverHttp(
      cofferUrl(),
      { method: "POST", path: "/v1/chat/completions", headers: {}, body: null },
      responder,
    );
    expect(responder.end).toHaveBeenCalledWith({ prompt_tokens: 2, completion_tokens: 4 });
  });

  it("handles a multibyte UTF-8 sequence split across chunks in the usage line", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const payload = Buffer.from(
        '{"response":"hé","done":true,"prompt_eval_count":3,"eval_count":4}\n',
      );
      // Split inside the two-byte encoding of "é" (0xC3 0xA9).
      const split = payload.indexOf(0xc3) + 1;
      res.write(payload.subarray(0, split));
      setTimeout(() => res.end(payload.subarray(split)), 20);
    };
    const responder = mockResponder();
    await forwardOverHttp(
      cofferUrl(),
      { method: "POST", path: "/api/generate", headers: {}, body: null },
      responder,
    );
    expect(responder.end).toHaveBeenCalledWith({ prompt_tokens: 3, completion_tokens: 4 });
  });

  it("aborts the upstream request on cancel and stays silent", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write("partial\n"); // never ends
    };
    const responder = mockResponder();
    const done = forwardOverHttp(
      cofferUrl(),
      { method: "POST", path: "/api/chat", headers: {}, body: null },
      responder,
    );
    await vi.waitFor(() => expect(responder.chunks.length).toBeGreaterThan(0));
    for (const cb of responder.cancelCbs) cb();
    await done;
    expect(responder.end).not.toHaveBeenCalled();
    expect(responder.error).not.toHaveBeenCalled();
  });

  it("sends an error frame when the upstream is unreachable", async () => {
    const responder = mockResponder();
    await forwardOverHttp(
      "http://127.0.0.1:1",
      { method: "POST", path: "/api/chat", headers: {}, body: null },
      responder,
    );
    expect(responder.error).toHaveBeenCalledWith("upstream request failed");
  });

  it("fetchModels returns model names", async () => {
    handler = (req, res) => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "llama3:latest" }, { model: "mistral" }] }));
      }
    };
    expect(await fetchModels(cofferUrl())).toEqual(["llama3:latest", "mistral"]);
  });
});
