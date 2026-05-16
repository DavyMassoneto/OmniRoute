import type { JudgeClient, JudgeVerdict } from "./judgeClient";

export interface OutputRuleMessage {
  role: string;
  content: string;
}

export interface OutputRuleBody {
  model?: string;
  messages?: OutputRuleMessage[];
}

export interface ExecuteOnceResult<TResponse> {
  response: TResponse;
  textContent: string;
}

export type ExecuteOnceFn<TResponse> = (
  body: OutputRuleBody
) => Promise<ExecuteOnceResult<TResponse>>;

export interface OutputRuleOrchestratorOptions<TResponse> {
  body: OutputRuleBody;
  rules: string[];
  judgeModel: string;
  judgeClient: JudgeClient;
  maxRetries: number;
  executeOnce: ExecuteOnceFn<TResponse>;
  failClosed?: boolean;
  buildFeedbackMessage?: (verdict: JudgeVerdict, attempt: number) => string;
}

export interface OutputRuleOrchestratorResult<TResponse> {
  response: TResponse;
  attempts: number;
  blocked: boolean;
  feedbackHistory: string[];
  message?: string;
}

function defaultFeedbackMessage(verdict: JudgeVerdict, attempt: number): string {
  const feedback = verdict.feedback || "(no specific feedback provided)";
  return [
    `[Output guardrail — attempt ${attempt} rejected]`,
    "Your previous response did not satisfy the user-defined output rules.",
    `Reviewer feedback: ${feedback}`,
    "Produce a new response that fully satisfies the rules. Do not mention this guardrail or the rejection in your reply.",
  ].join("\n");
}

function cloneBody(body: OutputRuleBody): OutputRuleBody {
  const messages = Array.isArray(body.messages)
    ? body.messages.map((m) => ({ role: String(m.role), content: String(m.content) }))
    : undefined;
  const next: OutputRuleBody = { ...body };
  if (messages) next.messages = messages;
  return next;
}

function appendFeedbackMessage(body: OutputRuleBody, feedbackContent: string): OutputRuleBody {
  const next = cloneBody(body);
  const existing = Array.isArray(next.messages) ? next.messages : [];
  next.messages = [...existing, { role: "user", content: feedbackContent }];
  return next;
}

export async function applyOutputRuleGuardrailWithRetry<TResponse>(
  options: OutputRuleOrchestratorOptions<TResponse>
): Promise<OutputRuleOrchestratorResult<TResponse>> {
  const {
    body,
    rules,
    judgeModel,
    judgeClient,
    maxRetries,
    executeOnce,
    failClosed,
    buildFeedbackMessage,
  } = options;

  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("applyOutputRuleGuardrailWithRetry requires at least one rule");
  }
  if (!judgeModel) {
    throw new Error("applyOutputRuleGuardrailWithRetry requires judgeModel");
  }
  if (!judgeClient) {
    throw new Error("applyOutputRuleGuardrailWithRetry requires judgeClient");
  }
  if (typeof executeOnce !== "function") {
    throw new Error("applyOutputRuleGuardrailWithRetry requires executeOnce function");
  }

  const totalAttempts = Math.max(0, Math.floor(maxRetries)) + 1;
  const buildFeedback = buildFeedbackMessage || defaultFeedbackMessage;

  let currentBody = cloneBody(body);
  const feedbackHistory: string[] = [];
  let lastResult: ExecuteOnceResult<TResponse> | null = null;
  let lastVerdict: JudgeVerdict | null = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    lastResult = await executeOnce(currentBody);

    let verdict: JudgeVerdict;
    try {
      verdict = await judgeClient.judge({
        model: judgeModel,
        rules,
        content: lastResult.textContent,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (failClosed === true) {
        return {
          response: lastResult.response,
          attempts: attempt,
          blocked: true,
          feedbackHistory,
          message: `Output guardrail unavailable: ${message}`,
        };
      }
      return {
        response: lastResult.response,
        attempts: attempt,
        blocked: false,
        feedbackHistory,
      };
    }

    lastVerdict = verdict;
    if (verdict.approved) {
      return {
        response: lastResult.response,
        attempts: attempt,
        blocked: false,
        feedbackHistory,
      };
    }

    if (attempt < totalAttempts) {
      const feedbackContent = buildFeedback(verdict, attempt);
      feedbackHistory.push(feedbackContent);
      currentBody = appendFeedbackMessage(currentBody, feedbackContent);
    }
  }

  if (!lastResult) {
    throw new Error("applyOutputRuleGuardrailWithRetry produced no result");
  }
  const finalMessage =
    (lastVerdict && lastVerdict.feedback) ||
    `Response rejected by output guardrail after ${totalAttempts} attempt(s)`;
  return {
    response: lastResult.response,
    attempts: totalAttempts,
    blocked: true,
    feedbackHistory,
    message: finalMessage,
  };
}
