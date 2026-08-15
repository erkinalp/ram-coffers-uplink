import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { wsTransport } from "../src/ws-transport.js";

describe("wsTransport", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, () => {}));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    port = address.port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("does not throw on a socket error after the transport is attached", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    wsTransport(ws);
    // EventEmitter throws on an "error" event without a listener; the transport
    // must keep one attached for the whole lifetime of the socket.
    expect(() => ws.emit("error", new Error("boom"))).not.toThrow();
    ws.close();
  });
});
