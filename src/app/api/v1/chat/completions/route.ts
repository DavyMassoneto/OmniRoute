import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { callCloudWithMachineId } from "@/shared/utils/cloud";
import { handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { createInjectionGuard } from "@/middleware/promptInjectionGuard";
import {
  wrapWithOutputRuleGuardrail,
  type ChatRequestBody,
} from "@omniroute/open-sse/handlers/outputGuardrailWrapper.ts";

let initPromise: Promise<void> | null = null;

// Singleton injection guard instance
const injectionGuard = createInjectionGuard();

/**
 * Initialize translators once (Promise-based singleton — no race condition)
 */
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
  return handleCorsOptions();
}

export async function POST(request: Request): Promise<Response> {
  await ensureInitialized();

  if (process.env.OMNIROUTE_LOG_REQUEST_SHAPE !== "0") {
    const ct: string = request.headers.get("content-type") ?? "";
    const cl: string | null = request.headers.get("content-length");
    if (cl && Number(cl) > 256 * 1024) {
      console.error(`[CHAT-ROUTE] large body content-type="${ct}" content-length=${cl}`);
    }
  }

  let parsedBody: ChatRequestBody | null = null;
  try {
    const cloned = request.clone();
    parsedBody = await cloned.json().catch(() => null);
  } catch {
    parsedBody = null;
  }

  try {
    if (parsedBody) {
      const { blocked, result } = injectionGuard(parsedBody);
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

  return wrapWithOutputRuleGuardrail(request, parsedBody, "openai", (req) => handleChat(req));
}
