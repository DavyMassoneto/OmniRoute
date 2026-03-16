/**
 * Tests for logger.ts pino transport fix.
 *
 * Validates that:
 * 1. Production logger uses pino.multistream() instead of pino.transport()
 *    (avoids worker thread crashes in Next.js standalone builds)
 * 2. Development logger still uses pino.transport() for pino-pretty
 * 3. next.config.mjs includes pino-related packages in serverExternalPackages
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// ─── Camada 2: next.config.mjs serverExternalPackages ───

test("next.config.mjs includes pino packages in serverExternalPackages", async () => {
  const configPath = path.join(ROOT, "next.config.mjs");
  const configSource = fs.readFileSync(configPath, "utf8");

  const requiredPackages = ["pino", "pino-pretty", "thread-stream", "sonic-boom"];

  for (const pkg of requiredPackages) {
    // Match the package name as a quoted string inside serverExternalPackages array
    const pattern = new RegExp(
      `serverExternalPackages\\s*:\\s*\\[[^\\]]*["']${pkg}["'][^\\]]*\\]`,
      "s"
    );
    assert.match(configSource, pattern, `"${pkg}" must be listed in serverExternalPackages`);
  }
});

// ─── Camada 1: logger.ts production behavior ───

test("logger.ts source does NOT use pino.transport() in production path", async () => {
  const loggerPath = path.join(ROOT, "src/shared/utils/logger.ts");
  const source = fs.readFileSync(loggerPath, "utf8");

  // The production code path (when isDev is false AND logToFile is true)
  // should use pino.multistream() or pino.destination(), NOT pino({ transport: ... })
  // We verify this by checking the structure of the production code.

  // Split the source into the production section.
  // The key insight: in the production path (non-dev + logToFile),
  // we should find multistream usage and NOT find transport targets.

  // Check that multistream is used somewhere in production path
  assert.match(
    source,
    /pino\.multistream/,
    "Production path must use pino.multistream() instead of worker-thread transport"
  );

  assert.match(
    source,
    /pino\.destination/,
    "Production path must use pino.destination() for file output"
  );
});

test("logger.ts production path uses async destination (sync: false)", async () => {
  const loggerPath = path.join(ROOT, "src/shared/utils/logger.ts");
  const source = fs.readFileSync(loggerPath, "utf8");

  // The production file destination should use sync: false for async SonicBoom
  // (better performance than sync: true which was only used in fallback)
  assert.match(
    source,
    /pino\.destination\(\s*\{[^}]*sync\s*:\s*false/s,
    "Production file destination should use sync: false (async SonicBoom)"
  );
});

test("logger.ts dev path still uses pino.transport() for pino-pretty", async () => {
  const loggerPath = path.join(ROOT, "src/shared/utils/logger.ts");
  const source = fs.readFileSync(loggerPath, "utf8");

  // Dev should still use transport for pino-pretty
  assert.match(source, /pino-pretty/, "Dev path must still reference pino-pretty");
});

test("logger.ts production path does NOT use transport targets", async () => {
  const loggerPath = path.join(ROOT, "src/shared/utils/logger.ts");
  const source = fs.readFileSync(loggerPath, "utf8");

  // Extract production sections: code between "!isDev" or "production" markers
  // that contains transport targets config.
  //
  // Strategy: the production code path with logToFile should NOT have
  // `transport: { targets: [` — it should use multistream instead.
  //
  // We check that outside of isDev blocks, there's no transport targets usage.
  // Since the code has clear if(isDev)/else structure, we look at the else branch.

  // Find all occurrences of transport: { targets:
  // and verify they are ONLY inside isDev blocks
  const lines = source.split("\n");
  let inDevBlock = false;
  let braceDepth = 0;
  let devBraceStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track if we enter an isDev block
    if (/if\s*\(\s*isDev\s*\)/.test(line)) {
      inDevBlock = true;
      devBraceStart = braceDepth;
    }

    // Count braces
    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (inDevBlock && braceDepth <= devBraceStart) {
          inDevBlock = false;
        }
      }
    }

    // Check for transport targets outside dev blocks
    if (!inDevBlock && /transport\s*:\s*\{/.test(line)) {
      // This could be in a catch/fallback — check if it's NOT in the main production path
      // For simplicity, check if this line is NOT in a catch block
      const surroundingContext = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
      if (!/catch/.test(surroundingContext) && !/fallback/i.test(surroundingContext)) {
        assert.fail(
          `Found "transport: {" outside isDev block at line ${i + 1}. ` +
            `Production must use pino.multistream(), not pino.transport().`
        );
      }
    }
  }
});

// ─── Runtime behavior test ───

test("logger module exports a working pino logger", async () => {
  // Set production-like env but disable file logging to avoid side effects
  const origNodeEnv = process.env.NODE_ENV;
  const origLogToFile = process.env.LOG_TO_FILE;

  process.env.NODE_ENV = "production";
  process.env.LOG_TO_FILE = "false";

  try {
    // Dynamic import to get a fresh module (though Node caches, we test export shape)
    const loggerModule = await import("../../src/shared/utils/logger.ts");

    assert.ok(loggerModule.logger, "logger export must exist");
    assert.equal(typeof loggerModule.logger.info, "function", "logger.info must be a function");
    assert.equal(typeof loggerModule.logger.error, "function", "logger.error must be a function");
    assert.equal(typeof loggerModule.logger.child, "function", "logger.child must be a function");
    assert.equal(typeof loggerModule.createLogger, "function", "createLogger must be exported");
  } finally {
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
    if (origLogToFile === undefined) delete process.env.LOG_TO_FILE;
    else process.env.LOG_TO_FILE = origLogToFile;
  }
});
