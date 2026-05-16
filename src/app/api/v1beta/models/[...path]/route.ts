import { buildClientRawRequest, handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { v1betaGeminiGenerateSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import type { GeminiBody } from "@/shared/validation/geminiTypes";
import {
  wrapWithOutputRuleGuardrail,
  type ChatRequestBody,
} from "@omniroute/open-sse/handlers/outputGuardrailWrapper.ts";

let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    await initTranslators();
    initialized = true;
    console.log("[SSE] Translators initialized for /v1beta/models");
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

function badRequestJson(message: string): Response {
  return Response.json(
    {
      error: {
        message,
        details: [{ field: "body", message }],
      },
    },
    { status: 400 }
  );
}

function resolveModelFromPath(path: string[]): string {
  if (path.length >= 2) {
    const provider = path[0];
    const modelAction = path[1];
    const modelName = modelAction
      .replace(":generateContent", "")
      .replace(":streamGenerateContent", "");
    return `${provider}/${modelName}`;
  }
  const modelAction = path[0];
  return modelAction.replace(":generateContent", "").replace(":streamGenerateContent", "");
}

function convertGeminiToInternal(geminiBody: GeminiBody, model: string): ChatRequestBody {
  const messages: { role: string; content: string }[] = [];

  if (geminiBody.systemInstruction) {
    const systemText =
      geminiBody.systemInstruction.parts?.map((p) => p.text ?? "").join("\n") || "";
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }

  if (geminiBody.contents) {
    for (const content of geminiBody.contents) {
      const role = content.role === "model" ? "assistant" : "user";
      const text = content.parts?.map((p) => p.text ?? "").join("\n") || "";
      messages.push({ role, content: text });
    }
  }

  const stream = geminiBody.generationConfig?.stream !== false;
  return { model, messages, stream };
}

/**
 * POST /v1beta/models/{model}:generateContent - Gemini compatible endpoint
 * Converts Gemini format to internal format and handles via handleChat.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  await ensureInitialized();

  let rawBody: GeminiBody;
  try {
    rawBody = await request.json();
  } catch {
    return badRequestJson("Invalid JSON body");
  }

  const resolved = await params;
  const path = resolved.path;

  const validation = validateBody(v1betaGeminiGenerateSchema, rawBody);
  if (isValidationFailure(validation)) {
    return Response.json({ error: validation.error }, { status: 400 });
  }
  const body = validation.data;

  const model = resolveModelFromPath(path);
  const convertedBody = convertGeminiToInternal(body, model);

  const newRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(convertedBody),
  });

  const clientRaw = buildClientRawRequest(request, rawBody);
  return wrapWithOutputRuleGuardrail(newRequest, convertedBody, "openai", (req) =>
    handleChat(req, clientRaw)
  );
}
