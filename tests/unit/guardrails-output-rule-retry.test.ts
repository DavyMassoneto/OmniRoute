import test from "node:test";
import assert from "node:assert/strict";

import { applyOutputRuleGuardrailWithRetry } from "../../src/lib/guardrails/outputRuleRetry.ts";

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatBody {
  model?: string;
  messages?: ChatMessage[];
}

interface ExecuteOnceResult {
  response: ChatBody;
  textContent: string;
}

interface JudgeVerdict {
  approved: boolean;
  feedback?: string;
}

function makeBody(text: string): ChatBody {
  return {
    model: "test-model",
    messages: [{ role: "user", content: text }],
  };
}

function makeResponse(text: string): ChatBody {
  return {
    model: "test-model",
    messages: [{ role: "assistant", content: text }],
  };
}

test("first attempt approved → no retry, attempts=1", async () => {
  let calls = 0;
  const result = await applyOutputRuleGuardrailWithRetry({
    body: makeBody("hi"),
    rules: ["r"],
    judgeModel: "m",
    maxRetries: 3,
    judgeClient: {
      judge: async () => ({ approved: true }),
    },
    executeOnce: async (): Promise<ExecuteOnceResult> => {
      calls++;
      return { response: makeResponse("ok"), textContent: "ok" };
    },
  });
  assert.equal(result.blocked, false);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});

test("rejected then approved → retries with feedback injected as user message", async () => {
  let calls = 0;
  const verdicts: JudgeVerdict[] = [{ approved: false, feedback: "too rude" }, { approved: true }];
  const bodiesSeen: ChatBody[] = [];

  const result = await applyOutputRuleGuardrailWithRetry({
    body: makeBody("be polite"),
    rules: ["polite"],
    judgeModel: "m",
    maxRetries: 3,
    judgeClient: {
      judge: async () => {
        const v = verdicts[calls - 1];
        return v;
      },
    },
    executeOnce: async (body): Promise<ExecuteOnceResult> => {
      calls++;
      bodiesSeen.push({
        model: body.model,
        messages: body.messages ? [...body.messages] : [],
      });
      return { response: makeResponse(`attempt-${calls}`), textContent: `attempt-${calls}` };
    },
  });

  assert.equal(result.blocked, false);
  assert.equal(result.attempts, 2);
  // First call: original messages only
  assert.equal(bodiesSeen[0].messages?.length, 1);
  // Second call: original + injected feedback message
  assert.equal(bodiesSeen[1].messages?.length, 2);
  const injected = bodiesSeen[1].messages?.[1];
  assert.equal(injected?.role, "user");
  assert.match(injected?.content || "", /too rude/);
});

test("all rejected up to maxRetries → returns blocked=true", async () => {
  let calls = 0;
  const result = await applyOutputRuleGuardrailWithRetry({
    body: makeBody("x"),
    rules: ["r"],
    judgeModel: "m",
    maxRetries: 2,
    judgeClient: {
      judge: async () => ({ approved: false, feedback: "nope" }),
    },
    executeOnce: async (): Promise<ExecuteOnceResult> => {
      calls++;
      return { response: makeResponse("a"), textContent: "a" };
    },
  });
  assert.equal(result.blocked, true);
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.match(result.message || "", /nope|guardrail|rejected/i);
});

test("maxRetries=0 → exactly one attempt, blocks on reject", async () => {
  let calls = 0;
  const result = await applyOutputRuleGuardrailWithRetry({
    body: makeBody("x"),
    rules: ["r"],
    judgeModel: "m",
    maxRetries: 0,
    judgeClient: {
      judge: async () => ({ approved: false, feedback: "x" }),
    },
    executeOnce: async (): Promise<ExecuteOnceResult> => {
      calls++;
      return { response: makeResponse("a"), textContent: "a" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.blocked, true);
});

test("body without messages array → starts a messages array on injection", async () => {
  let calls = 0;
  const bodies: ChatBody[] = [];
  const verdicts: JudgeVerdict[] = [{ approved: false, feedback: "fb" }, { approved: true }];
  await applyOutputRuleGuardrailWithRetry({
    body: { model: "m" },
    rules: ["r"],
    judgeModel: "m",
    maxRetries: 1,
    judgeClient: {
      judge: async () => verdicts[calls - 1],
    },
    executeOnce: async (body): Promise<ExecuteOnceResult> => {
      calls++;
      bodies.push({
        model: body.model,
        messages: body.messages ? [...body.messages] : [],
      });
      return { response: makeResponse("x"), textContent: "x" };
    },
  });
  // After retry, body should have a messages array with the feedback msg
  assert.equal(bodies[1].messages?.length, 1);
  assert.equal(bodies[1].messages?.[0].role, "user");
  assert.match(bodies[1].messages?.[0].content || "", /fb/);
});

test("each retry appends a new feedback message (cumulative)", async () => {
  let calls = 0;
  const bodies: ChatBody[] = [];
  const verdicts: JudgeVerdict[] = [
    { approved: false, feedback: "f1" },
    { approved: false, feedback: "f2" },
    { approved: true },
  ];
  await applyOutputRuleGuardrailWithRetry({
    body: makeBody("hi"),
    rules: ["r"],
    judgeModel: "m",
    maxRetries: 3,
    judgeClient: {
      judge: async () => verdicts[calls - 1],
    },
    executeOnce: async (body): Promise<ExecuteOnceResult> => {
      calls++;
      bodies.push({
        model: body.model,
        messages: body.messages
          ? body.messages.map((m) => ({ role: m.role, content: m.content }))
          : [],
      });
      return { response: makeResponse("r"), textContent: "r" };
    },
  });
  // Attempt 3 body: original (1) + feedback 1 + feedback 2 = 3 messages
  assert.equal(bodies[2].messages?.length, 3);
  assert.match(bodies[2].messages?.[1].content || "", /f1/);
  assert.match(bodies[2].messages?.[2].content || "", /f2/);
});
