import test from "node:test";
import assert from "node:assert/strict";

import { OutputRuleGuardrail } from "../../src/lib/guardrails/outputRule.ts";

interface JudgeVerdict {
  approved: boolean;
  feedback?: string;
}

interface JudgeCall {
  model: string;
  rules: string[];
  content: string;
}

interface FakeJudge {
  judge: (call: JudgeCall) => Promise<JudgeVerdict>;
}

function approvingJudge(): FakeJudge {
  return {
    judge: async () => ({ approved: true }),
  };
}

function rejectingJudge(feedback: string): FakeJudge {
  return {
    judge: async () => ({ approved: false, feedback }),
  };
}

function throwingJudge(message: string): FakeJudge {
  return {
    judge: async () => {
      throw new Error(message);
    },
  };
}

test("extracts content from OpenAI chat-completions choices format", async () => {
  let received: string | null = null;
  const guardrail = new OutputRuleGuardrail({
    rules: ["no curse words"],
    judgeModel: "gpt-5-mini",
    judgeClient: {
      judge: async (call) => {
        received = call.content;
        return { approved: true };
      },
    },
  });

  const response = {
    choices: [{ message: { role: "assistant", content: "hello world" } }],
  };
  await guardrail.postCall(response, {});
  assert.equal(received, "hello world");
});

test("extracts content from Anthropic content blocks", async () => {
  let received: string | null = null;
  const guardrail = new OutputRuleGuardrail({
    rules: ["r"],
    judgeModel: "m",
    judgeClient: {
      judge: async (call) => {
        received = call.content;
        return { approved: true };
      },
    },
  });

  const response = {
    content: [
      { type: "text", text: "part one " },
      { type: "text", text: "part two" },
    ],
  };
  await guardrail.postCall(response, {});
  assert.equal(received, "part one part two");
});

test("extracts content from OpenAI Responses output array", async () => {
  let received: string | null = null;
  const guardrail = new OutputRuleGuardrail({
    rules: ["r"],
    judgeModel: "m",
    judgeClient: {
      judge: async (call) => {
        received = call.content;
        return { approved: true };
      },
    },
  });

  const response = {
    output: [
      {
        type: "message",
        content: [
          { type: "output_text", text: "alpha " },
          { type: "output_text", text: "beta" },
        ],
      },
    ],
  };
  await guardrail.postCall(response, {});
  assert.equal(received, "alpha beta");
});

test("judge approves → guardrail passes through (no block, no meta.blocked)", async () => {
  const guardrail = new OutputRuleGuardrail({
    rules: ["r"],
    judgeModel: "m",
    judgeClient: approvingJudge(),
  });
  const result = await guardrail.postCall({ choices: [{ message: { content: "ok" } }] }, {});
  assert.ok(result);
  assert.notEqual(result.block, true);
  assert.equal(result.meta?.approved, true);
});

test("judge rejects → guardrail blocks with feedback exposed in meta", async () => {
  const guardrail = new OutputRuleGuardrail({
    rules: ["no slur"],
    judgeModel: "m",
    judgeClient: rejectingJudge("contains forbidden term"),
  });
  const result = await guardrail.postCall({ choices: [{ message: { content: "bad text" } }] }, {});
  assert.ok(result);
  assert.equal(result.block, true);
  assert.equal(result.meta?.approved, false);
  assert.equal(result.meta?.feedback, "contains forbidden term");
});

test("judge throws + failClosed:false → fail open (pass through)", async () => {
  const guardrail = new OutputRuleGuardrail({
    rules: ["r"],
    judgeModel: "m",
    failClosed: false,
    judgeClient: throwingJudge("network down"),
  });
  const result = await guardrail.postCall({ choices: [{ message: { content: "ok" } }] }, {});
  assert.ok(result);
  assert.notEqual(result.block, true);
  assert.equal(result.meta?.judgeError, "network down");
});

test("judge throws + failClosed:true → blocks request", async () => {
  const guardrail = new OutputRuleGuardrail({
    rules: ["r"],
    judgeModel: "m",
    failClosed: true,
    judgeClient: throwingJudge("network down"),
  });
  const result = await guardrail.postCall({ choices: [{ message: { content: "x" } }] }, {});
  assert.ok(result);
  assert.equal(result.block, true);
});

test("no rules configured → guardrail is no-op (no judge invocation)", async () => {
  let invoked = 0;
  const guardrail = new OutputRuleGuardrail({
    rules: [],
    judgeModel: "m",
    judgeClient: {
      judge: async () => {
        invoked++;
        return { approved: true };
      },
    },
  });
  const result = await guardrail.postCall({ choices: [{ message: { content: "x" } }] }, {});
  assert.equal(invoked, 0);
  assert.notEqual(result?.block, true);
});
