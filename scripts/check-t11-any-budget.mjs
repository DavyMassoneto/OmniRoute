#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();

/**
 * T11 Phase-A budget:
 * keep explicit `any` at zero in files already hardened.
 */
const budget = [
  { file: "src/app/api/settings/proxy/route.ts", maxAny: 0 },
  { file: "src/app/api/settings/proxy/test/route.ts", maxAny: 0 },
  { file: "src/shared/components/OAuthModal.tsx", maxAny: 0 },
  { file: "open-sse/translator/index.ts", maxAny: 0 },
  { file: "open-sse/translator/registry.ts", maxAny: 0 },
  // Freeze legacy hot spots to avoid any-regression while strict migration continues.
  { file: "src/lib/db/apiKeys.ts", maxAny: 0 },
  { file: "src/lib/db/providers.ts", maxAny: 0 },
  { file: "src/lib/db/settings.ts", maxAny: 0 },
  { file: "open-sse/config/providerRegistry.ts", maxAny: 0 },
  { file: "open-sse/config/providerModels.ts", maxAny: 0 },
  { file: "open-sse/mcp-server/server.ts", maxAny: 0 },
];

const anyRegex = /\bany\b/g;
let hasFailure = false;

for (const item of budget) {
  const absolutePath = path.resolve(cwd, item.file);
  if (!fs.existsSync(absolutePath)) {
    console.error(`[t11:any-budget] FAIL - file not found: ${item.file}`);
    hasFailure = true;
    continue;
  }

  const content = fs.readFileSync(absolutePath, "utf8");
  const matches = content.match(anyRegex);
  const count = matches ? matches.length : 0;
  const status = count <= item.maxAny ? "OK" : "FAIL";

  if (status === "FAIL") {
    hasFailure = true;
  }

  console.log(
    `[t11:any-budget] ${status} - ${item.file} (explicit any: ${count}, budget: ${item.maxAny})`
  );
}

if (hasFailure) {
  process.exit(1);
}

console.log("[t11:any-budget] PASS - explicit any budget respected.");
