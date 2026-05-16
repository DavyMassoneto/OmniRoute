import { handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import {
  wrapWithOutputRuleGuardrail,
  type ChatRequestBody,
} from "@omniroute/open-sse/handlers/outputGuardrailWrapper.ts";

let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    await initTranslators();
    initialized = true;
    console.log("[SSE] Translators initialized for /v1/responses/*");
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

/**
 * POST /v1/responses/:path* - OpenAI Responses subpaths
 * Reuses the shared chat handler so native Codex passthrough can keep
 * arbitrary Responses suffixes all the way to the upstream provider.
 */
export async function POST(request: Request): Promise<Response> {
  await ensureInitialized();

  let parsedBody: ChatRequestBody | null = null;
  try {
    const cloned = request.clone();
    parsedBody = await cloned.json().catch(() => null);
  } catch {
    parsedBody = null;
  }

  return wrapWithOutputRuleGuardrail(request, parsedBody, "openai-responses", (req) =>
    handleChat(req)
  );
}
