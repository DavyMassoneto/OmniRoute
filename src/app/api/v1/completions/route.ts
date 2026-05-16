import { CORS_HEADERS } from "@/shared/utils/cors";
import { buildClientRawRequest, handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { createInjectionGuard } from "@/middleware/promptInjectionGuard";
import {
  wrapWithOutputRuleGuardrail,
  type ChatRequestBody,
} from "@omniroute/open-sse/handlers/outputGuardrailWrapper.ts";

let initPromise: Promise<void> | null = null;
const injectionGuard = createInjectionGuard();

function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = Promise.resolve(initTranslators()).then(() => {
      console.log("[SSE] Translators initialized");
    });
  }
  return initPromise;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/completions — Legacy OpenAI Completions API
 *
 * Accepts both the modern chat format (messages[]) and the legacy
 * text-completions format (prompt string). Legacy requests are
 * automatically normalized to chat/completions format before routing.
 *
 * @see https://platform.openai.com/docs/api-reference/completions
 */
export async function POST(request: Request): Promise<Response> {
  await ensureInitialized();

  let originalBody: ChatRequestBody | null = null;
  try {
    const cloned = request.clone();
    originalBody = await cloned.json().catch(() => null);
  } catch {
    originalBody = null;
  }

  try {
    if (originalBody) {
      const { blocked, result } = injectionGuard(originalBody);
      if (blocked) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Request blocked: potential prompt injection detected",
              type: "injection_detected",
              code: "SECURITY_001",
              detections: result.detections.length,
            },
          }),
          { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }
    }
  } catch (error) {
    console.error("[SECURITY] Prompt injection guard failed:", error);
  }

  // Legacy prompt→messages normalization. If applicable, build a normalized
  // body+request once and use that as the wrapper's source of truth.
  const legacyPrompt = originalBody?.prompt;
  if (originalBody && legacyPrompt !== undefined && !originalBody.messages) {
    const promptText = Array.isArray(legacyPrompt) ? legacyPrompt.join("\n") : String(legacyPrompt);
    const normalized: ChatRequestBody = {
      ...originalBody,
      messages: [{ role: "user", content: promptText }],
    };
    delete normalized.prompt;

    const normalizedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(normalized),
    });
    const clientRaw = buildClientRawRequest(request, originalBody);
    return wrapWithOutputRuleGuardrail(normalizedRequest, normalized, "openai", (req) =>
      handleChat(req, clientRaw)
    );
  }

  return wrapWithOutputRuleGuardrail(request, originalBody, "openai", (req) => handleChat(req));
}
