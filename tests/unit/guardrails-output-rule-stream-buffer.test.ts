import test from "node:test";
import assert from "node:assert/strict";

import { bufferUpstreamStream } from "../../open-sse/utils/streamBuffer.ts";

function sseResponse(body: string, contentType = "text/event-stream"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("buffers SSE bytes into Uint8Array preserving original payload", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
    "data: [DONE]\n\n";
  const buffered = await bufferUpstreamStream(sseResponse(sse), {
    targetFormat: "openai",
    model: "test-model",
  });
  assert.ok(buffered.bytes instanceof Uint8Array);
  const decoded = new TextDecoder().decode(buffered.bytes);
  assert.equal(decoded, sse);
  assert.equal(buffered.status, 200);
  assert.equal(buffered.contentType, "text/event-stream");
});

test("extracts text content from OpenAI delta SSE", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"world"}}]}\n\n' +
    "data: [DONE]\n\n";
  const buffered = await bufferUpstreamStream(sseResponse(sse), {
    targetFormat: "openai",
    model: "m",
  });
  assert.equal(buffered.textContent, "hello world");
});

test("extracts text content from Anthropic event SSE", async () => {
  const sse =
    "event: message_start\n" +
    'data: {"type":"message_start","message":{"id":"x","model":"y","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
    "event: content_block_start\n" +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
    "event: content_block_delta\n" +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part-a"}}\n\n' +
    "event: content_block_delta\n" +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part-b"}}\n\n' +
    "event: content_block_stop\n" +
    'data: {"type":"content_block_stop","index":0}\n\n' +
    "event: message_stop\n" +
    'data: {"type":"message_stop"}\n\n';
  const buffered = await bufferUpstreamStream(sseResponse(sse), {
    targetFormat: "claude",
    model: "claude-test",
  });
  assert.equal(buffered.textContent, "part-apart-b");
});

test("non-streaming JSON response is buffered with textContent extracted", async () => {
  const json = JSON.stringify({
    choices: [{ message: { role: "assistant", content: "plain answer" } }],
  });
  const buffered = await bufferUpstreamStream(jsonResponse(json), {
    targetFormat: "openai",
    model: "m",
  });
  assert.equal(buffered.textContent, "plain answer");
  assert.equal(buffered.contentType, "application/json");
  assert.equal(new TextDecoder().decode(buffered.bytes), json);
});

test("empty stream still returns empty buffer + empty text without throwing", async () => {
  const buffered = await bufferUpstreamStream(sseResponse(""), {
    targetFormat: "openai",
    model: "m",
  });
  assert.equal(buffered.bytes.length, 0);
  assert.equal(buffered.textContent, "");
});
