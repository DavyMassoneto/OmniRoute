import { handleChat } from "@/sse/handlers/chat";
import {
  wrapWithOutputRuleGuardrail,
  type ChatRequestBody,
} from "@omniroute/open-sse/handlers/outputGuardrailWrapper.ts";

// NOTE: We do NOT call initTranslators() here — the translator registry is
// bootstrapped at module level inside open-sse/translator/index.ts when it
// is first imported. Calling it again from a Next.js Route Handler caused a
// "the worker has exited" uncaughtException crash on Codex CLI requests (#450)
// because the dynamic import runs in a Next.js server worker context where
// certain Node APIs used by the translator bootstrap are not available.
// The translators are always initialized via the open-sse side (chatCore),
// so /v1/responses just delegates to handleChat which handles everything.

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/responses - OpenAI Responses API format
 * Handled by the unified chat handler (openai-responses format auto-detected).
 */
export async function POST(request: Request): Promise<Response> {
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
