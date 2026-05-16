import { BaseGuardrail, type GuardrailContext, type GuardrailResult } from "./base";
import type { JudgeClient, JudgeVerdict } from "./judgeClient";

export interface OutputRuleGuardrailOptions {
  rules?: string | string[];
  judgeModel?: string;
  judgeClient?: JudgeClient;
  failClosed?: boolean;
  enabled?: boolean;
  priority?: number;
}

export interface ContentBlock {
  type?: string;
  text?: string;
  content?: string;
}

export interface ChatMessageShape {
  role?: string;
  content?: string | ContentBlock[];
}

export interface ChatChoiceShape {
  message?: ChatMessageShape;
}

export interface ResponsesOutputItem {
  type?: string;
  content?: string | ContentBlock[];
}

export interface UpstreamResponseShape {
  choices?: ChatChoiceShape[];
  content?: ContentBlock[];
  output?: ResponsesOutputItem[];
  output_text?: string;
  message?: ChatMessageShape;
}

export const OUTPUT_RULE_GUARDRAIL_NAME = "output-rule";
const DEFAULT_PRIORITY = 90;

function normalizeRules(rules: string | string[] | undefined): string[] {
  if (!rules) return [];
  if (Array.isArray(rules)) {
    return rules.filter((r) => typeof r === "string" && r.trim().length > 0);
  }
  if (typeof rules === "string") {
    return rules
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }
  return [];
}

function pushFromContentBlocks(blocks: ContentBlock[] | undefined, out: string[]): void {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string" && block.text.length > 0) {
      out.push(block.text);
      continue;
    }
    if (typeof block.content === "string" && block.content.length > 0) {
      out.push(block.content);
    }
  }
}

export function extractTextContent(
  response: UpstreamResponseShape | string | null | undefined
): string {
  if (response === null || response === undefined) return "";
  if (typeof response === "string") return response;
  if (typeof response !== "object") return "";

  const parts: string[] = [];

  if (Array.isArray(response.choices)) {
    for (const choice of response.choices) {
      if (!choice || typeof choice !== "object") continue;
      const msg = choice.message;
      if (!msg || typeof msg !== "object") continue;
      if (typeof msg.content === "string") {
        parts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        pushFromContentBlocks(msg.content, parts);
      }
    }
  }

  if (Array.isArray(response.content)) {
    pushFromContentBlocks(response.content, parts);
  }

  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.content === "string") {
        parts.push(item.content);
      } else if (Array.isArray(item.content)) {
        pushFromContentBlocks(item.content, parts);
      }
    }
  }

  if (typeof response.output_text === "string") parts.push(response.output_text);

  if (response.message && typeof response.message === "object") {
    if (typeof response.message.content === "string") {
      parts.push(response.message.content);
    } else if (Array.isArray(response.message.content)) {
      pushFromContentBlocks(response.message.content, parts);
    }
  }

  return parts.join("");
}

export class OutputRuleGuardrail extends BaseGuardrail {
  private readonly rules: string[];
  private readonly judgeModel: string;
  private readonly judgeClient: JudgeClient | undefined;
  private readonly failClosed: boolean;

  constructor(options: OutputRuleGuardrailOptions = {}) {
    super(OUTPUT_RULE_GUARDRAIL_NAME, {
      enabled: options.enabled !== false,
      priority: options.priority ?? DEFAULT_PRIORITY,
    });
    this.rules = normalizeRules(options.rules);
    this.judgeModel = options.judgeModel || "";
    this.judgeClient = options.judgeClient;
    this.failClosed = options.failClosed === true;
  }

  hasRules(): boolean {
    return this.rules.length > 0;
  }

  getRules(): string[] {
    return [...this.rules];
  }

  getJudgeModel(): string {
    return this.judgeModel;
  }

  override async postCall(
    response: UpstreamResponseShape | string | null | undefined,
    _context: GuardrailContext
  ): Promise<GuardrailResult | void> {
    if (!this.hasRules()) return { block: false };
    if (!this.judgeClient) {
      if (this.failClosed) {
        return {
          block: true,
          message: "Output guardrail unavailable (no judge client configured)",
          meta: { approved: false, judgeError: "no judge client" },
        };
      }
      return { block: false, meta: { judgeError: "no judge client" } };
    }
    if (!this.judgeModel) {
      if (this.failClosed) {
        return {
          block: true,
          message: "Output guardrail unavailable (no judge model configured)",
          meta: { approved: false, judgeError: "no judge model" },
        };
      }
      return { block: false, meta: { judgeError: "no judge model" } };
    }

    const content = extractTextContent(response);
    let verdict: JudgeVerdict;
    try {
      verdict = await this.judgeClient.judge({
        model: this.judgeModel,
        rules: this.rules,
        content,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.failClosed) {
        return {
          block: true,
          message: `Output guardrail unavailable: ${message}`,
          meta: { approved: false, judgeError: message },
        };
      }
      return { block: false, meta: { judgeError: message } };
    }

    if (verdict.approved) {
      return { block: false, meta: { approved: true } };
    }

    return {
      block: true,
      message: verdict.feedback || "Response rejected by output guardrail",
      meta: { approved: false, feedback: verdict.feedback || null },
    };
  }
}
