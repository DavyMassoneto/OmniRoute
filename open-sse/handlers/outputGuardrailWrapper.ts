// Route-level wrapper that buffers any LLM response (streaming or
// non-streaming), judges it against user-defined output rules via a
// configurable judge model, and transparently retries the upstream call
// with cumulative feedback until approval or maxRetries. The client never
// observes partial tokens of rejected attempts nor learns how many
// retries occurred. NOT consumed by React components.

import {
  applyOutputRuleGuardrailWithRetry,
  type OutputRuleBody,
} from "@/lib/guardrails/outputRuleRetry";
import { OpenAICompatJudgeClient, type JudgeClient } from "@/lib/guardrails/judgeClient";
import { bufferUpstreamStream, createReplayResponse } from "../utils/streamBuffer";

export interface OutputRuleRouteConfig {
  enabled: boolean;
  rules: string[];
  judgeModel: string;
  maxRetries: number;
  failClosed: boolean;
  judgeClient: JudgeClient | null;
  targetFormat: string;
  modelHint: string;
}

export interface ChatRequestBody {
  model?: string;
  messages?: { role: string; content: string }[];
  metadata?: ChatRequestMetadata;
  stream?: boolean;
  prompt?: string | string[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
}

export interface ChatRequestMetadata {
  output_rules?: string | string[];
  output_rule_judge_model?: string;
  output_rule_max_retries?: number;
  output_rule_fail_closed?: boolean;
}

export interface OutputRuleDbSettings {
  outputRuleEnabled?: boolean;
  outputRuleRules?: string | string[];
  outputRuleJudgeModel?: string;
  outputRuleMaxRetries?: number;
  outputRuleFailClosed?: boolean;
}

interface ResolvedRulesInput {
  rules: string[];
  judgeModel: string;
  maxRetries: number;
  failClosed: boolean;
  disabledByDb: boolean;
}

export interface RunWithGuardrailOptions {
  request: Request;
  body: ChatRequestBody;
  config: OutputRuleRouteConfig;
  handler: (request: Request) => Promise<Response>;
}

const DEFAULT_MAX_RETRIES = 3;

function parseRulesList(value: string | string[] | null | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((r) => String(r).trim()).filter((r) => r.length > 0);
  }
  return String(value)
    .split(/\r?\n|,/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

function readHeader(headers: Headers, name: string): string | undefined {
  const v = headers.get(name);
  return v === null ? undefined : v;
}

function readNumber(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readBool(value: string | undefined): boolean | null {
  if (value === undefined || value === null) return null;
  const lower = value.toLowerCase().trim();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  return null;
}

async function loadDbSettings(): Promise<OutputRuleDbSettings | null> {
  try {
    const mod = await import("@/lib/db/settings");
    const settings = await mod.getSettings();
    if (!settings || typeof settings !== "object") return null;
    return {
      outputRuleEnabled:
        typeof settings.outputRuleEnabled === "boolean" ? settings.outputRuleEnabled : undefined,
      outputRuleRules:
        typeof settings.outputRuleRules === "string" || Array.isArray(settings.outputRuleRules)
          ? settings.outputRuleRules
          : undefined,
      outputRuleJudgeModel:
        typeof settings.outputRuleJudgeModel === "string"
          ? settings.outputRuleJudgeModel
          : undefined,
      outputRuleMaxRetries:
        typeof settings.outputRuleMaxRetries === "number"
          ? settings.outputRuleMaxRetries
          : undefined,
      outputRuleFailClosed:
        typeof settings.outputRuleFailClosed === "boolean"
          ? settings.outputRuleFailClosed
          : undefined,
    };
  } catch {
    return null;
  }
}

export function resolveOutputRuleConfig(
  headers: Headers,
  body: ChatRequestBody | null,
  dbSettings: OutputRuleDbSettings | null
): ResolvedRulesInput {
  const headerRules = readHeader(headers, "x-omniroute-output-rules");
  const bodyMetadata = body?.metadata;
  const bodyRules =
    typeof bodyMetadata?.output_rules === "string" || Array.isArray(bodyMetadata?.output_rules)
      ? bodyMetadata.output_rules
      : undefined;
  const dbRules = dbSettings?.outputRuleRules;
  const envRules = process.env.OUTPUT_RULE_RULES;

  const fromHeader = parseRulesList(headerRules);
  const fromBody = parseRulesList(bodyRules);
  const fromDb = parseRulesList(dbRules);
  const fromEnv = parseRulesList(envRules);
  let finalRules: string[] = [];
  if (fromHeader.length > 0) finalRules = fromHeader;
  else if (fromBody.length > 0) finalRules = fromBody;
  else if (fromDb.length > 0) finalRules = fromDb;
  else finalRules = fromEnv;

  const judgeModel =
    readHeader(headers, "x-omniroute-output-rule-judge-model") ||
    (typeof bodyMetadata?.output_rule_judge_model === "string"
      ? bodyMetadata.output_rule_judge_model
      : "") ||
    dbSettings?.outputRuleJudgeModel ||
    process.env.OUTPUT_RULE_JUDGE_MODEL ||
    "";

  const maxRetriesHeader = readNumber(readHeader(headers, "x-omniroute-output-rule-max-retries"));
  const maxRetriesBody =
    typeof bodyMetadata?.output_rule_max_retries === "number"
      ? bodyMetadata.output_rule_max_retries
      : null;
  const maxRetriesDb =
    typeof dbSettings?.outputRuleMaxRetries === "number" ? dbSettings.outputRuleMaxRetries : null;
  const maxRetriesEnv = readNumber(process.env.OUTPUT_RULE_MAX_RETRIES);
  let maxRetries = DEFAULT_MAX_RETRIES;
  if (maxRetriesHeader !== null) maxRetries = maxRetriesHeader;
  else if (maxRetriesBody !== null) maxRetries = maxRetriesBody;
  else if (maxRetriesDb !== null) maxRetries = maxRetriesDb;
  else if (maxRetriesEnv !== null) maxRetries = maxRetriesEnv;

  const failClosedHeader = readBool(readHeader(headers, "x-omniroute-output-rule-fail-closed"));
  const failClosedBody =
    typeof bodyMetadata?.output_rule_fail_closed === "boolean"
      ? bodyMetadata.output_rule_fail_closed
      : null;
  const failClosedDb =
    typeof dbSettings?.outputRuleFailClosed === "boolean" ? dbSettings.outputRuleFailClosed : null;
  const failClosedEnv = readBool(process.env.OUTPUT_RULE_FAIL_CLOSED);
  let failClosed = false;
  if (failClosedHeader !== null) failClosed = failClosedHeader;
  else if (failClosedBody !== null) failClosed = failClosedBody;
  else if (failClosedDb !== null) failClosed = failClosedDb;
  else if (failClosedEnv !== null) failClosed = failClosedEnv;

  // Master toggle: when DB explicitly says disabled and no per-request override
  // (header/body) provided rules, treat the whole feature as off — even if env
  // var or DB rules are populated. This lets the UI toggle act as a kill switch
  // without erasing the saved rules.
  const disabledByDb =
    dbSettings?.outputRuleEnabled === false && fromHeader.length === 0 && fromBody.length === 0;

  return {
    rules: finalRules,
    judgeModel,
    maxRetries: Math.max(0, Math.floor(maxRetries)),
    failClosed,
    disabledByDb,
  };
}

function resolveJudgeBaseUrl(): string {
  return (
    process.env.OUTPUT_RULE_JUDGE_BASE_URL || `http://127.0.0.1:${process.env.PORT || "20128"}`
  );
}

function resolveJudgeApiKey(): string | undefined {
  return (
    process.env.OUTPUT_RULE_JUDGE_API_KEY || process.env.OUTPUT_RULE_INTERNAL_API_KEY || undefined
  );
}

function buildJudgeClient(): JudgeClient {
  return new OpenAICompatJudgeClient({
    baseUrl: resolveJudgeBaseUrl(),
    apiKey: resolveJudgeApiKey(),
  });
}

export async function buildRouteConfig(
  headers: Headers,
  body: ChatRequestBody | null,
  targetFormat: string,
  modelHint: string
): Promise<OutputRuleRouteConfig> {
  const dbSettings = await loadDbSettings();
  const resolved = resolveOutputRuleConfig(headers, body, dbSettings);
  const enabled =
    !resolved.disabledByDb && resolved.rules.length > 0 && resolved.judgeModel.length > 0;
  return {
    enabled,
    rules: resolved.rules,
    judgeModel: resolved.judgeModel,
    maxRetries: resolved.maxRetries,
    failClosed: resolved.failClosed,
    judgeClient: enabled ? buildJudgeClient() : null,
    targetFormat,
    modelHint,
  };
}

function cloneRequestWithBody(original: Request, newBodyJson: string): Request {
  const newHeaders = new Headers(original.headers);
  newHeaders.set("content-type", "application/json");
  newHeaders.delete("content-length");
  return new Request(original.url, {
    method: original.method,
    headers: newHeaders,
    body: newBodyJson,
  });
}

function buildGuardrailErrorResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "output_guardrail_blocked",
        code: "OUTPUT_GUARDRAIL_001",
      },
    }),
    {
      status: 400,
      headers: { "content-type": "application/json" },
    }
  );
}

export async function wrapWithOutputRuleGuardrail(
  request: Request,
  body: ChatRequestBody | null,
  targetFormat: string,
  handler: (request: Request) => Promise<Response>
): Promise<Response> {
  if (!body) return handler(request);
  // Bypass the guardrail for internal judge calls — without this, the judge
  // re-enters this wrapper, fires its own judge call, and loops until the
  // upstream errors out.
  if (request.headers.get("x-omniroute-internal-judge") === "1") {
    return handler(request);
  }
  const modelHint = typeof body.model === "string" ? body.model : "";
  const config = await buildRouteConfig(request.headers, body, targetFormat, modelHint);
  if (!config.enabled || !config.judgeClient) return handler(request);
  return runWithOutputRuleGuardrail({ request, body, config, handler });
}

export async function runWithOutputRuleGuardrail(
  options: RunWithGuardrailOptions
): Promise<Response> {
  const { request, body, config, handler } = options;

  if (!config.enabled || !config.judgeClient) {
    return handler(request);
  }

  const orchestratorBody: OutputRuleBody = {
    model: body.model,
    messages: Array.isArray(body.messages)
      ? body.messages.map((m) => ({ role: String(m.role), content: String(m.content) }))
      : undefined,
  };

  const orchestrator = await applyOutputRuleGuardrailWithRetry({
    body: orchestratorBody,
    rules: config.rules,
    judgeModel: config.judgeModel,
    judgeClient: config.judgeClient,
    maxRetries: config.maxRetries,
    failClosed: config.failClosed,
    executeOnce: async (mutated) => {
      const nextBody: ChatRequestBody = {
        ...body,
        messages: mutated.messages,
      };
      const nextRequest = cloneRequestWithBody(request, JSON.stringify(nextBody));
      const upstreamResponse = await handler(nextRequest);
      const buffered = await bufferUpstreamStream(upstreamResponse, {
        targetFormat: config.targetFormat,
        model: body.model || config.modelHint,
      });
      return { response: buffered, textContent: buffered.textContent };
    },
  });

  if (orchestrator.blocked) {
    return buildGuardrailErrorResponse(
      orchestrator.message || "Response rejected by output guardrail"
    );
  }

  return createReplayResponse(orchestrator.response);
}
