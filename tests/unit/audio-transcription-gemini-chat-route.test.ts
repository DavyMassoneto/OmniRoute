import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { handleAudioTranscription } from "../../open-sse/handlers/audioTranscription.ts";
import * as registry from "../../open-sse/config/audioRegistry.ts";
import { errorResponse } from "../../open-sse/utils/error.ts";

const source = fs.readFileSync(
  new URL("../../src/app/api/v1/audio/transcriptions/route.ts", import.meta.url),
  "utf8"
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function loadRoute(chat: (request: Request) => Promise<Response>) {
  const modules: Record<string, unknown> = {
    "@omniroute/open-sse/handlers/audioTranscription.ts": { handleAudioTranscription },
    "@omniroute/open-sse/config/audioRegistry.ts": registry,
    "@/sse/handlers/chat": { handleChat: chat },
    "@/lib/providerModels/modelEndpointGuard": {
      getRequestedModelEndpointMismatch: async () => null,
    },
    "@/shared/network/remoteImageFetch": {
      fetchRemoteMedia: async () => assert.fail("No remote downloads"),
    },
    "@/sse/services/auth": {
      getProviderCredentialsWithQuotaPreflight: async () =>
        assert.fail("Chat owns credential selection"),
    },
    "@/app/api/v1/_shared/audioProviderNodes": { resolveDynamicAudioProviders: async () => [] },
    "@omniroute/open-sse/utils/error.ts": { errorResponse },
    "@omniroute/open-sse/config/constants.ts": {
      HTTP_STATUS: { BAD_REQUEST: 400, FORBIDDEN: 403 },
    },
    "@/sse/services/model": { getCombinedModelAliases: async () => ({}) },
    "@omniroute/open-sse/services/wildcardRouter.ts": { resolveModel: (model: string) => model },
    "@omniroute/open-sse/services/model.ts": { resolveModelAliasFromMap: () => null },
    "@/lib/db/apiKeys": { isModelAllowedForKey: async () => true },
    "@/shared/utils/apiKeyPolicy": {
      enforceApiKeyPolicy: async (request: Request) => {
        assert.equal(request.headers.get("authorization"), "Bearer caller-key");
        return { apiKey: "caller-key", apiKeyInfo: { id: "caller-id", name: "caller" } };
      },
    },
    "@/sse/services/keyConnectionScope": {
      resolveKeyConnectionScope: async () => ({ allowedConnections: ["caller-connection"] }),
    },
    "@/app/api/v1/_shared/rateLimit": {},
    "@/domain/omnirouteResponseMeta": {},
    "@/shared/utils/requestId": {},
    "@/lib/db/combos": {},
    "@/lib/db/databaseSettings": {},
    "@omniroute/open-sse/services/combo.ts": {},
    "@omniroute/open-sse/utils/logger.ts": {},
    "@/lib/usageDb": { saveCallLog: async () => assert.fail("Chat owns telemetry") },
  };
  const exports: { POST?: (request: Request) => Promise<Response> } = {};
  runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      assert.ok(name in modules, `Unexpected dependency ${name}`);
      return modules[name];
    },
    Request,
    Response,
    Headers,
    FormData,
    URL,
    Date,
  });
  return exports.POST!;
}

function request(model: string) {
  const body = new FormData();
  body.set("model", model);
  body.set("file", new File(["abc"], "pt.m4a", { type: "audio/mp4" }));
  return new Request("http://localhost/v1/audio/transcriptions", {
    method: "POST",
    body,
    headers: {
      authorization: "Bearer caller-key",
      "x-omniroute-self-loop-key-id": "caller-id",
      "x-request-id": "caller-request",
    },
  });
}

test("transcription POST forwards caller headers, signal and model into in-process chat", async () => {
  const input = request("agy/gemini-3.8-flash-low");
  const post = loadRoute(async (chatRequest) => {
    assert.equal(chatRequest.url, "http://localhost/v1/chat/completions");
    assert.equal(chatRequest.headers.get("authorization"), "Bearer caller-key");
    assert.equal(chatRequest.headers.get("x-omniroute-self-loop-key-id"), "caller-id");
    assert.equal(chatRequest.headers.get("x-request-id"), "caller-request");
    assert.equal(chatRequest.headers.get("content-type"), "application/json");
    const body = await chatRequest.json();
    assert.equal(body.model, "agy/gemini-3.8-flash-low");
    assert.equal(body.messages[0].content[0].input_audio.format, "m4a");
    assert.equal(chatRequest.signal.aborted, input.signal.aborted);
    return Response.json({ choices: [{ message: { content: "route transcript" } }] });
  });
  const response = await post(input);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "route transcript", noSpeechDetected: false });
});

test("transcription POST leaves unknown provider errors unchanged", async () => {
  const post = loadRoute(async () => assert.fail("No chat call"));
  const response = await post(request("unknown/model"));
  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).error.message,
    "Invalid transcription model: unknown/model. Use format: provider/model"
  );
});

test("transcription POST preserves chat quota rejections", async () => {
  const post = loadRoute(async () =>
    Response.json({ error: { message: "Quota exceeded" } }, { status: 429 })
  );
  const response = await post(request("antigravity/gemini-3-flash"));
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.message, "Quota exceeded");
});
