// Utility module — buffers an upstream Response (streaming SSE or non-streaming
// JSON) into a single in-memory snapshot so a post-call judge can evaluate the
// full content before any bytes are forwarded to the client. Used exclusively
// by server-side guardrail orchestration. NOT consumed by React components.

import {
  parseSSEToOpenAIResponse,
  parseSSEToClaudeResponse,
  parseSSEToResponsesOutput,
} from "../handlers/sseParser.ts";
import { extractTextContent, type UpstreamResponseShape } from "@/lib/guardrails/outputRule";

export interface BufferStreamOptions {
  targetFormat: string;
  model: string;
}

export interface BufferedUpstreamResponse {
  bytes: Uint8Array;
  textContent: string;
  contentType: string;
  status: number;
  statusText: string;
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

async function readAllBytes(response: Response): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        chunks.push(value);
        total += value.length;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader already released
    }
  }
  return concatChunks(chunks, total);
}

function isSseContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes("text/event-stream") || lower.includes("application/x-ndjson");
}

function normalizeFormat(format: string): string {
  return String(format || "")
    .toLowerCase()
    .trim();
}

function isClaudeFormat(format: string): boolean {
  const f = normalizeFormat(format);
  return f === "claude" || f === "anthropic";
}

function isResponsesFormat(format: string): boolean {
  const f = normalizeFormat(format);
  return f === "openai-responses" || f === "responses";
}

function extractFromSse(raw: string, format: string, model: string): string {
  if (isClaudeFormat(format)) {
    const parsed = parseSSEToClaudeResponse(raw, model);
    if (parsed) return extractTextContent(parsed);
  }
  if (isResponsesFormat(format)) {
    const parsed = parseSSEToResponsesOutput(raw, model);
    if (parsed) return extractTextContent(parsed);
  }
  const parsedOpenAI = parseSSEToOpenAIResponse(raw, model);
  if (parsedOpenAI) return extractTextContent(parsedOpenAI);
  const parsedClaude = parseSSEToClaudeResponse(raw, model);
  if (parsedClaude) return extractTextContent(parsedClaude);
  return "";
}

function extractFromJson(raw: string): string {
  if (!raw) return "";
  try {
    const parsed: UpstreamResponseShape = JSON.parse(raw);
    return extractTextContent(parsed);
  } catch {
    return "";
  }
}

export async function bufferUpstreamStream(
  response: Response,
  options: BufferStreamOptions
): Promise<BufferedUpstreamResponse> {
  const contentType = response.headers.get("content-type") || "";
  const status = response.status;
  const statusText = response.statusText;

  const bytes = await readAllBytes(response);

  if (bytes.length === 0) {
    return {
      bytes,
      textContent: "",
      contentType,
      status,
      statusText,
    };
  }

  const raw = new TextDecoder().decode(bytes);

  const textContent = isSseContentType(contentType)
    ? extractFromSse(raw, options.targetFormat, options.model)
    : extractFromJson(raw);

  return {
    bytes,
    textContent,
    contentType,
    status,
    statusText,
  };
}

export function createReplayResponse(
  buffered: BufferedUpstreamResponse,
  extraHeaders?: Headers
): Response {
  const headers = new Headers();
  if (buffered.contentType) headers.set("content-type", buffered.contentType);
  if (extraHeaders) {
    extraHeaders.forEach((value, key) => headers.set(key, value));
  }
  const body = new Blob([buffered.bytes]);
  return new Response(body, {
    status: buffered.status,
    statusText: buffered.statusText,
    headers,
  });
}
