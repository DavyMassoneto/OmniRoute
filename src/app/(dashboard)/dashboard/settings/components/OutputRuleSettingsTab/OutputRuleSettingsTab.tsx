"use client";

// Co-located interfaces live in ./interfaces.ts (see neighbor file
// OutputRuleSettingsTab/interfaces.ts which exports OutputRuleSettingsState).

import { useEffect, useState } from "react";
import { Card, Toggle } from "@/shared/components";
import type { OutputRuleSettingsState } from "./interfaces";

type RulesValueInput = string | string[] | null | undefined | number | boolean;

const DEFAULT_STATE: OutputRuleSettingsState = {
  outputRuleEnabled: false,
  outputRuleRules: "",
  outputRuleJudgeModel: "",
  outputRuleMaxRetries: 3,
  outputRuleFailClosed: false,
};

function coerceRulesValue(value: RulesValueInput): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string" && v.trim().length > 0).join("\n");
  }
  return "";
}

function countActiveRules(text: string): number {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

export default function OutputRuleSettingsTab() {
  const [settings, setSettings] = useState<OutputRuleSettingsState>(DEFAULT_STATE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        setSettings({
          outputRuleEnabled: data.outputRuleEnabled === true,
          outputRuleRules: coerceRulesValue(data.outputRuleRules),
          outputRuleJudgeModel:
            typeof data.outputRuleJudgeModel === "string" ? data.outputRuleJudgeModel : "",
          outputRuleMaxRetries:
            typeof data.outputRuleMaxRetries === "number" ? data.outputRuleMaxRetries : 3,
          outputRuleFailClosed: data.outputRuleFailClosed === true,
        });
      })
      .finally(() => setLoading(false));
  }, []);

  const updateSetting = async (patch: Partial<OutputRuleSettingsState>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...patch }));
      }
    } catch (error) {
      console.error("Failed to update output-rule settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const activeRules = countActiveRules(settings.outputRuleRules);
  const judgeModelTrimmed = settings.outputRuleJudgeModel.trim();
  const isMisconfigured =
    settings.outputRuleEnabled && (activeRules === 0 || judgeModelTrimmed.length === 0);

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            rule
          </span>
        </div>
        <div>
          <h3 className="text-lg font-semibold">Output Rule Guardrail</h3>
          <p className="text-sm text-text-muted">
            Buffer every LLM response (streaming included), judge it against your rules with a
            configurable judge model, and silently retry the upstream call when rejected. Clients
            never see rejected content or partial tokens of failed attempts.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">Enabled</p>
            <p className="text-sm text-text-muted">
              Master kill switch. When off, the guardrail is bypassed on all routes even if rules
              are saved.
            </p>
          </div>
          <Toggle
            checked={settings.outputRuleEnabled}
            onChange={(checked) => updateSetting({ outputRuleEnabled: checked })}
            disabled={loading || saving}
          />
        </div>

        {isMisconfigured ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            Enabled but incomplete: provide both at least one rule and a judge model, otherwise the
            guardrail stays inactive at runtime.
          </div>
        ) : null}

        <div className="pt-4 border-t border-border space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Rules
              <span className="ml-2 text-xs text-text-muted">
                ({activeRules} active rule{activeRules === 1 ? "" : "s"})
              </span>
            </label>
            <textarea
              value={settings.outputRuleRules}
              onChange={(e) =>
                setSettings((prev) => ({ ...prev, outputRuleRules: e.target.value }))
              }
              onBlur={() => updateSetting({ outputRuleRules: settings.outputRuleRules })}
              className="min-h-[140px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm font-mono"
              placeholder={
                "One rule per line. Examples:\nDo not use profanity\nReply in Portuguese\nNever expose internal API endpoints"
              }
              disabled={loading}
            />
            <p className="text-xs text-text-muted mt-1">
              Each non-empty line is one rule. The judge model evaluates whether the full LLM reply
              satisfies all rules. Empty lines are ignored.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Judge Model</label>
            <input
              type="text"
              value={settings.outputRuleJudgeModel}
              onChange={(e) =>
                setSettings((prev) => ({ ...prev, outputRuleJudgeModel: e.target.value }))
              }
              onBlur={() =>
                updateSetting({ outputRuleJudgeModel: settings.outputRuleJudgeModel.trim() })
              }
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              placeholder="openai/gpt-4o-mini"
              disabled={loading}
            />
            <p className="text-xs text-text-muted mt-1">
              Any model ID registered in OmniRoute. The judge call is routed back through
              <code className="mx-1 px-1 rounded bg-black/10 dark:bg-white/10">
                /v1/chat/completions
              </code>
              internally, so it can be any provider — including free ones.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Max Retries</label>
              <input
                type="number"
                min={0}
                max={10}
                value={settings.outputRuleMaxRetries}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    outputRuleMaxRetries: Number.parseInt(e.target.value, 10) || 0,
                  }))
                }
                onBlur={() =>
                  updateSetting({
                    outputRuleMaxRetries: Math.min(
                      10,
                      Math.max(0, settings.outputRuleMaxRetries || 0)
                    ),
                  })
                }
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                disabled={loading}
              />
              <p className="text-xs text-text-muted mt-1">
                Total upstream calls = retries + 1. Each attempt costs upstream tokens normally.
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium">Fail Closed</p>
                  <p className="text-xs text-text-muted">
                    When ON and the judge is unreachable, block the response. When OFF, the response
                    passes through unjudged.
                  </p>
                </div>
                <Toggle
                  checked={settings.outputRuleFailClosed}
                  onChange={(checked) => updateSetting({ outputRuleFailClosed: checked })}
                  disabled={loading || saving}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="pt-4 border-t border-border">
          <p className="text-xs text-text-muted">
            Precedence per request: header (<code>x-omniroute-output-rules</code>) → body (
            <code>metadata.output_rules</code>) → these settings → env (<code>OUTPUT_RULE_*</code>
            ). Headers and body still override the UI per-request for advanced use.
          </p>
        </div>
      </div>
    </Card>
  );
}
