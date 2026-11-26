import test from "node:test";
import assert from "node:assert/strict";
import { handleAudioTranscription } from "../../open-sse/handlers/audioTranscription.ts";

function audioForm(model = "agy/gemini-3.8-flash-low") {
  const formData = new FormData();
  formData.set("model", model);
  formData.set("file", new File(["abc"], "pt.m4a", { type: "audio/mp4" }));
  return formData;
}

test("Gemini chat transcribes through an injected internal chat handler", async () => {
  let captured:
    { model: string; stream: boolean; messages: Array<{ content: unknown[] }> } | undefined;
  const response = await handleAudioTranscription({
    formData: audioForm(),
    credentials: null,
    chatHandler: async (body) => {
      captured = body;
      return Response.json({ choices: [{ message: { content: "Olá mundo" } }] });
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "Olá mundo", noSpeechDetected: false });
  assert.equal(captured?.model, "agy/gemini-3.8-flash-low");
  assert.equal(captured?.stream, false);
  assert.deepEqual(captured?.messages[0].content[0], {
    type: "input_audio",
    input_audio: { data: "YWJj", format: "m4a" },
  });
  assert.match((captured?.messages[0].content[1] as { text: string }).text, /Brazilian Portuguese/);
  assert.match((captured?.messages[0].content[1] as { text: string }).text, /verbatim/);
});

for (const provider of ["agy", "antigravity"]) {
  for (const model of [
    "gemini-3.8-flash-low",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-high",
    "gemini-3-flash",
  ]) {
    test(`${provider}/${model} is listed and transcribes silence`, async () => {
      const { getAllAudioModels } = await import("../../open-sse/config/audioRegistry.ts");
      assert.ok(getAllAudioModels().some((entry) => entry.id === `${provider}/${model}`));
      const response = await handleAudioTranscription({
        formData: audioForm(`${provider}/${model}`),
        chatHandler: async (body) => {
          assert.equal(body.model, `${provider}/${model}`);
          return Response.json({ choices: [{ message: { content: "" } }] });
        },
      });
      assert.deepEqual(await response.json(), { text: "", noSpeechDetected: true });
    });
  }
}

for (const [name, mime, format] of [
  ["clip.m4a", "audio/mp4", "m4a"],
  ["clip.mp3", "audio/mpeg", "mp3"],
  ["clip.wav", "audio/x-wav", "wav"],
  ["clip.M4A", "", "m4a"],
  ["clip.mp3", "application/octet-stream", "mp3"],
  ["clip.wav", "", "wav"],
  ["clip.ogg", "audio/ogg", "ogg"],
  ["clip.flac", "audio/flac", "flac"],
  ["clip.aac", "audio/aac", "aac"],
]) {
  test(`Gemini detects ${name} (${mime}) as ${format}`, async () => {
    const formData = audioForm();
    formData.set("file", new File(["abc"], name, { type: mime }));
    const response = await handleAudioTranscription({
      formData,
      chatHandler: async (body) => {
        assert.equal(
          (body.messages[0].content[0] as { input_audio: { format: string } }).input_audio.format,
          format
        );
        return Response.json({ choices: [{ message: { content: "text" } }] });
      },
    });
    assert.equal(response.status, 200);
  });
}

test("Gemini forwards explicit language and prompt", async () => {
  const formData = audioForm();
  formData.set("language", "en");
  formData.set("prompt", "Open Code terminology");
  formData.set("response_format", "verbose_json");
  const response = await handleAudioTranscription({
    formData,
    chatHandler: async (body) => {
      const instruction = (body.messages[0].content[1] as { text: string }).text;
      assert.match(instruction, /in en\./);
      assert.match(instruction, /Open Code terminology/);
      return Response.json({ choices: [{ message: { content: "hello" } }] });
    },
  });
  assert.deepEqual(await response.json(), {
    task: "transcribe",
    language: "en",
    duration: 0,
    text: "hello",
    segments: [],
    noSpeechDetected: false,
  });
});

test("Gemini rejects unsupported formats before calling chat", async () => {
  const formData = audioForm();
  formData.set("file", new File(["abc"], "clip.webm", { type: "audio/webm" }));
  const response = await handleAudioTranscription({
    formData,
    chatHandler: async () => {
      assert.fail("chat must not run");
    },
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /Unsupported audio format/);
});

test("Gemini rejects files over the shared 25 MB limit before reading bytes", async () => {
  const { GEMINI_LIVE_MAX_INPUT_BYTES } =
    await import("../../open-sse/executors/geminiLiveTranscribe.ts");
  const formData = audioForm();
  formData.set(
    "file",
    new File([new Uint8Array(GEMINI_LIVE_MAX_INPUT_BYTES + 1)], "clip.wav", { type: "audio/wav" })
  );
  const response = await handleAudioTranscription({
    formData,
    chatHandler: async () => {
      assert.fail("chat must not run");
    },
  });
  assert.equal(response.status, 413);
});

for (const status of [400, 401, 403, 429, 500, 502, 503]) {
  test(`Gemini preserves provider status ${status} with an OpenAI error`, async () => {
    const response = await handleAudioTranscription({
      formData: audioForm(),
      chatHandler: async () =>
        Response.json({ error: { message: "Provider rejected request" } }, { status }),
    });
    assert.equal(response.status, status);
    const payload = await response.json();
    assert.equal(payload.error.message, "Provider rejected request");
    assert.equal(typeof payload.error.type, "string");
  });
}

test("Gemini rejects an unregistered model with the existing format hint", async () => {
  const model = "agy/not-registered";
  const response = await handleAudioTranscription({ formData: audioForm(model) });
  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).error.message,
    `Invalid transcription model: ${model}. Use format: provider/model`
  );
});

for (const model of ["whisper-large", "nova-2", "whisper-1"]) {
  test(`Deepgram ${model} retains the binary upload and response contract`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      assert.equal(new URL(String(url)).searchParams.get("model"), model);
      assert.ok(init?.body instanceof ArrayBuffer);
      return Response.json({
        results: { channels: [{ alternatives: [{ transcript: "deepgram text" }] }] },
      });
    }) as typeof fetch;
    try {
      const response = await handleAudioTranscription({
        formData: audioForm(`deepgram/${model}`),
        credentials: { apiKey: "test-key" },
      });
      assert.deepEqual(await response.json(), { text: "deepgram text", noSpeechDetected: false });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
