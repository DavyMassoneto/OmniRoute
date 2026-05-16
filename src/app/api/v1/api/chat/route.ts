import { handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { transformToOllama } from "@omniroute/open-sse/utils/ollamaTransform.ts";
import {
  wrapWithOutputRuleGuardrail,
  type ChatRequestBody,
} from "@omniroute/open-sse/handlers/outputGuardrailWrapper.ts";

let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    await initTranslators();
    initialized = true;
    console.log("[SSE] Translators initialized");
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  await ensureInitialized();

  let parsedBody: ChatRequestBody | null = null;
  let modelName = "llama3.2";
  try {
    const cloned = request.clone();
    parsedBody = await cloned.json().catch(() => null);
    if (parsedBody && typeof parsedBody.model === "string" && parsedBody.model.length > 0) {
      modelName = parsedBody.model;
    }
  } catch {
    parsedBody = null;
  }

  // Wrap handleChat with the guardrail (judges OpenAI-format internal
  // response). Ollama transform runs only on the approved final response so
  // the client never sees Ollama-shaped tokens for rejected attempts.
  const guarded = await wrapWithOutputRuleGuardrail(request, parsedBody, "openai", (req) =>
    handleChat(req)
  );

  // Guardrail blocked responses are JSON errors — pass through untransformed.
  if (guarded.status >= 400) return guarded;
  return transformToOllama(guarded, modelName);
}
