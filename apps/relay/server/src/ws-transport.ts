import type { FrameTransport } from "@ram-coffers-uplink/protocol";
import type { WebSocket } from "ws";

export function wsTransport(ws: WebSocket): FrameTransport {
  return {
    send: (data) => ws.send(data),
    onMessage: (cb) => ws.on("message", (data: Buffer) => cb(new Uint8Array(data))),
    onClose: (cb) => ws.on("close", cb),
    close: () => ws.close(),
  };
}
