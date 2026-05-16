import test from "node:test";
import assert from "node:assert/strict";

import { OpenAICompatJudgeClient } from "../../src/lib/guardrails/judgeClient.ts";

interface JudgeBodyMessage {
  role: string;
  content: string;
}

interface JudgeBody {
  model: string;
  messages: JudgeBodyMessage[];
}

function parseJudgeBody(raw: string): JudgeBody {
  const data = JSON.parse(raw);
  if (!data || typeof data.model !== "string" || !Array.isArray(data.messages)) {
    throw new Error("invalid judge body shape");
  }
  const messages: JudgeBodyMessage[] = [];
  for (const m of data.messages) {
    if (!m || typeof m.role !== "string" || typeof m.content !== "string") {
      throw new Error("invalid judge message shape");
    }
    messages.push({ role: m.role, content: m.content });
  }
  return { model: data.model, messages };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface FakeFetchHandle {
  impl: typeof fetch;
  calls: FetchCall[];
}

function fakeFetch(
  responder: (url: string, init: RequestInit) => Promise<Response> | Response
): FakeFetchHandle {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const initObj: RequestInit = init || {};
    calls.push({ url, init: initObj });
    return responder(url, initObj);
  };
  return { impl, calls };
}

function readRequestBody(init: RequestInit): string {
  if (typeof init.body === "string") return init.body;
  return "";
}

test("judge posts to baseUrl + /v1/chat/completions with auth header", async () => {
  const { impl, calls } = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"approved":true}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
  );

  const client = new OpenAICompatJudgeClient({
    baseUrl: "http://localhost:20128",
    apiKey: "sk-test",
    fetchImpl: impl,
  });

  await client.judge({
    model: "gpt-5-mini",
    rules: ["no curse words"],
    content: "hello",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:20128/v1/chat/completions");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer sk-test");
  assert.equal(headers.get("content-type"), "application/json");
});

test("judge includes rules and content in the user prompt", async () => {
  let capturedBody: JudgeBody | null = null;
  const { impl } = fakeFetch((_url, init) => {
    capturedBody = parseJudgeBody(readRequestBody(init));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"approved":true}' } }] }),
      { status: 200 }
    );
  });

  const client = new OpenAICompatJudgeClient({
    baseUrl: "http://localhost:20128",
    fetchImpl: impl,
  });

  await client.judge({
    model: "gpt-5-mini",
    rules: ["RULE A", "RULE B"],
    content: "RESPONSE TEXT",
  });

  assert.ok(capturedBody, "fetch must have been called");
  assert.equal(capturedBody.model, "gpt-5-mini");
  assert.ok(capturedBody.messages.length >= 1);
  const combined = capturedBody.messages.map((m) => m.content).join("\n");
  assert.match(combined, /RULE A/);
  assert.match(combined, /RULE B/);
  assert.match(combined, /RESPONSE TEXT/);
});

test("judge parses plain JSON verdict", async () => {
  const { impl } = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"approved":false,"feedback":"contains forbidden term"}' } },
          ],
        }),
        { status: 200 }
      )
  );
  const client = new OpenAICompatJudgeClient({
    baseUrl: "http://x",
    fetchImpl: impl,
  });
  const verdict = await client.judge({ model: "m", rules: ["r"], content: "c" });
  assert.equal(verdict.approved, false);
  assert.equal(verdict.feedback, "contains forbidden term");
});

test("judge parses fenced ```json``` verdict", async () => {
  const fenced = '```json\n{"approved":true,"feedback":"ok"}\n```';
  const { impl } = fakeFetch(
    () =>
      new Response(JSON.stringify({ choices: [{ message: { content: fenced } }] }), { status: 200 })
  );
  const client = new OpenAICompatJudgeClient({
    baseUrl: "http://x",
    fetchImpl: impl,
  });
  const verdict = await client.judge({ model: "m", rules: ["r"], content: "c" });
  assert.equal(verdict.approved, true);
});

test("judge throws when HTTP status is non-2xx", async () => {
  const { impl } = fakeFetch(() => new Response("server error", { status: 503 }));
  const client = new OpenAICompatJudgeClient({
    baseUrl: "http://x",
    fetchImpl: impl,
  });
  await assert.rejects(
    () => client.judge({ model: "m", rules: ["r"], content: "c" }),
    /judge|503/i
  );
});

test("judge throws on malformed verdict content", async () => {
  const { impl } = fakeFetch(
    () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }), {
        status: 200,
      })
  );
  const client = new OpenAICompatJudgeClient({
    baseUrl: "http://x",
    fetchImpl: impl,
  });
  await assert.rejects(() => client.judge({ model: "m", rules: ["r"], content: "c" }));
});
