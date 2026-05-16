export interface JudgeCall {
  model: string;
  rules: string[];
  content: string;
}

export interface JudgeVerdict {
  approved: boolean;
  feedback?: string;
}

export interface JudgeClient {
  judge(call: JudgeCall): Promise<JudgeVerdict>;
}

export interface OpenAICompatJudgeClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are an output-policy judge. Decide whether the assistant response below " +
  "satisfies ALL of the user-provided rules. Reply with ONLY a single-line JSON " +
  'object: {"approved": true} when every rule is satisfied, or ' +
  '{"approved": false, "feedback": "<short, actionable correction the assistant ' +
  'should follow on retry>"} when any rule is violated. Do not include any other ' +
  "text, prose, or formatting outside the JSON.";

const DEFAULT_TIMEOUT_MS = 30_000;

function buildUserPrompt(rules: string[], content: string): string {
  const rulesBlock = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
  return [
    "RULES THE ASSISTANT MUST FOLLOW:",
    rulesBlock,
    "",
    "ASSISTANT RESPONSE TO EVALUATE:",
    content,
  ].join("\n");
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function parseVerdictData(raw: string): JudgeVerdict {
  const unfenced = stripCodeFence(raw);
  const jsonBlock = extractJsonObject(unfenced) || unfenced;
  const data = JSON.parse(jsonBlock);
  if (!data || typeof data.approved !== "boolean") {
    throw new Error("Judge response missing required boolean 'approved' field");
  }
  if (typeof data.feedback === "string") {
    return { approved: data.approved, feedback: data.feedback };
  }
  return { approved: data.approved };
}

function extractChoiceContent(payload: string): string {
  const data = JSON.parse(payload);
  if (
    !data ||
    !Array.isArray(data.choices) ||
    data.choices.length === 0 ||
    !data.choices[0] ||
    !data.choices[0].message ||
    typeof data.choices[0].message.content !== "string"
  ) {
    throw new Error("Judge upstream returned malformed chat-completions payload");
  }
  return data.choices[0].message.content;
}

export class OpenAICompatJudgeClient implements JudgeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly systemPrompt: string;

  constructor(options: OpenAICompatJudgeClientOptions) {
    if (!options.baseUrl) {
      throw new Error("OpenAICompatJudgeClient requires baseUrl");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  }

  async judge(call: JudgeCall): Promise<JudgeVerdict> {
    if (!call.model) throw new Error("judge() requires a model name");
    if (!Array.isArray(call.rules) || call.rules.length === 0) {
      throw new Error("judge() requires at least one rule");
    }

    const headers = new Headers();
    headers.set("content-type", "application/json");
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);

    const requestBody = JSON.stringify({
      model: call.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: buildUserPrompt(call.rules, call.content) },
      ],
      temperature: 0,
      stream: false,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: requestBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const snippet = text.slice(0, 200);
      throw new Error(`Judge upstream returned HTTP ${response.status}: ${snippet}`);
    }

    const payload = await response.text();
    const verdictText = extractChoiceContent(payload);
    return parseVerdictData(verdictText);
  }
}
