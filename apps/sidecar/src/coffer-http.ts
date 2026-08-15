import type { Responder, Usage } from "@ram-coffers-uplink/protocol";

export interface UpstreamRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

export async function fetchModels(baseUrl: string): Promise<string[]> {
  const res = await fetch(new URL("/api/tags", baseUrl));
  if (!res.ok) return [];
  const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
  return (body.models ?? []).map((m) => m.name ?? m.model ?? "").filter((name) => name.length > 0);
}

/** Best-effort usage extraction from NDJSON (Ollama-style) or SSE (OpenAI-style) streams. */
class UsageParser {
  private buffer = "";
  private last: Record<string, unknown> | null = null;
  private readonly decoder = new TextDecoder();

  feed(chunk: Uint8Array): void {
    // One decoder for the whole stream: multibyte UTF-8 sequences split across
    // chunks must not be replaced with U+FFFD.
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      this.parseLine(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
    }
  }

  result(): Usage | null {
    this.buffer += this.decoder.decode();
    this.parseLine(this.buffer);
    const obj = this.last;
    if (!obj) return null;
    const usage = obj.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
    const prompt =
      numberOrUndefined(obj.prompt_eval_count) ?? numberOrUndefined(usage?.prompt_tokens);
    const completion =
      numberOrUndefined(obj.eval_count) ?? numberOrUndefined(usage?.completion_tokens);
    if (prompt === undefined && completion === undefined) return null;
    return { prompt_tokens: prompt ?? 0, completion_tokens: completion ?? 0 };
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "data: [DONE]") return;
    const json = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null)
        this.last = parsed as Record<string, unknown>;
    } catch {
      // Partial or non-JSON line: usage extraction is best-effort.
    }
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export async function forwardOverHttp(
  baseUrl: string,
  msg: UpstreamRequest,
  responder: Responder,
): Promise<void> {
  const controller = new AbortController();
  responder.onCancel(() => controller.abort());
  try {
    const upstream = await fetch(new URL(msg.path, baseUrl), {
      method: msg.method,
      headers: msg.headers,
      body: msg.body ? Buffer.from(msg.body, "base64") : undefined,
      signal: controller.signal,
    });
    responder.sendHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    if (!upstream.body) {
      responder.sendEnd(null);
      return;
    }
    const reader = upstream.body.getReader();
    const parser = new UsageParser();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(value);
      responder.sendChunk(value);
    }
    responder.sendEnd(parser.result());
  } catch {
    if (controller.signal.aborted) return;
    responder.sendError("upstream request failed");
  }
}
