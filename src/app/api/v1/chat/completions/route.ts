import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { callCloudWithMachineId } from "@/shared/utils/cloud";
import { handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { createInjectionGuard } from "@/middleware/promptInjectionGuard";
import {
  buildRouteConfig,
  runWithOutputRuleGuardrail,
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

  // One-line marker for diagnosing 413 / Server-Action interceptions.
  // Logs only when Content-Length is present so debug noise stays low for
  // typical chat payloads. Toggle off via OMNIROUTE_LOG_REQUEST_SHAPE=0.
  if (process.env.OMNIROUTE_LOG_REQUEST_SHAPE !== "0") {
    const ct: string = request.headers.get("content-type") ?? "";
    const cl: string | null = request.headers.get("content-length");
    if (cl && Number(cl) > 256 * 1024) {
      console.error(`[CHAT-ROUTE] large body content-type="${ct}" content-length=${cl}`);
    }
  }

  // Read body once for both injection guard and output guardrail config.
  let parsedBody: ChatRequestBody | null = null;
  try {
    const cloned = request.clone();
    parsedBody = await cloned.json().catch(() => null);
  } catch {
    parsedBody = null;
  }

  // Prompt injection guard — inspect body before forwarding
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

  const modelHint = parsedBody && typeof parsedBody.model === "string" ? parsedBody.model : "";

  const outputRuleConfig = buildRouteConfig(request.headers, parsedBody, "openai", modelHint);

  if (outputRuleConfig.enabled && parsedBody) {
    return await runWithOutputRuleGuardrail({
      request,
      body: parsedBody,
      config: outputRuleConfig,
      handler: (req) => handleChat(req),
    });
  }

  return await handleChat(request);
}
