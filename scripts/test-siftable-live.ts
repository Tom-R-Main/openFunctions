#!/usr/bin/env tsx
/**
 * Live e2e test of the modernized Siftable context provider.
 *
 * Proves end-to-end that:
 *   - createSiftableProvider().connect() reaches the API
 *   - The wrapper-over-SiftClient is wired correctly
 *   - SIFT_PAT (or legacy EXF_PAT) auth resolves
 *   - The connected provider can buildContext() against the real account
 *
 * Run: tsx scripts/test-siftable-live.ts
 *   Requires: SIFT_PAT in env (or .env), or legacy EXF_PAT
 *   Optional: SIFT_API_URL (defaults to https://execufunction.com)
 *             SIFT_WORKSPACE_ID
 */

import "../src/framework/env.js";
import { ToolRegistry } from "../src/framework/index.js";
import { connectProvider } from "../src/framework/index.js";
import { createSiftableProvider } from "../src/providers/execufunction/index.js";

const token = process.env.SIFT_PAT ?? process.env.EXF_PAT;
if (!token) {
  console.error("\n  ❌ SIFT_PAT (or EXF_PAT) not set. Aborting.\n");
  process.exit(2);
}

console.log("\n╔══════════════════════════════════════════════════╗");
console.log("║  Siftable provider live e2e test                 ║");
console.log("╚══════════════════════════════════════════════════╝\n");

const apiUrl =
  process.env.SIFT_API_URL ??
  process.env.EXF_API_URL ??
  "https://execufunction.com";
console.log(`  API URL:    ${apiUrl}`);
console.log(`  Token:      ${token.slice(0, 12)}…`);
console.log(
  `  Workspace:  ${process.env.SIFT_WORKSPACE_ID ?? process.env.EXF_WORKSPACE_ID ?? "(default)"}`,
);
console.log();

const registry = new ToolRegistry();
const start = Date.now();

const failures: string[] = [];
let toolsCount = 0;
let healthOk = false;
let contextSnippet = "";

try {
  const sift = await connectProvider(createSiftableProvider(), registry);
  toolsCount = registry.listNames().length;
  console.log(`  ✓ connectProvider ok — ${toolsCount} tools registered`);

  const health = await sift.healthCheck?.();
  if (health?.ok) {
    healthOk = true;
    console.log("  ✓ healthCheck ok");
  } else {
    failures.push(`healthCheck failed: ${health?.error ?? "unknown"}`);
    console.log(`  ✗ healthCheck failed: ${health?.error}`);
  }

  // buildContext is best-effort and depends on what's in the account.
  // We just want to confirm it returns without throwing.
  try {
    const ctx = await sift.buildContext?.();
    if (ctx) {
      contextSnippet = ctx.slice(0, 200);
      console.log(`  ✓ buildContext returned ${ctx.length} chars`);
    } else {
      console.log("  ✓ buildContext returned undefined (no current context)");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`buildContext threw: ${msg}`);
    console.log(`  ✗ buildContext threw: ${msg}`);
  }

  // Spot-check one tool execution: list projects.
  try {
    const result = await registry.execute("exf_projects_list", {});
    if (!result.success) {
      failures.push(`exf_projects_list failed: ${result.error}`);
      console.log(`  ✗ exf_projects_list failed: ${result.error}`);
    } else {
      const data = result.data as { projects?: unknown[] };
      const count = Array.isArray(data?.projects) ? data.projects.length : 0;
      console.log(`  ✓ exf_projects_list ok — ${count} project(s)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`exf_projects_list threw: ${msg}`);
    console.log(`  ✗ exf_projects_list threw: ${msg}`);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  failures.push(`connectProvider threw: ${msg}`);
  console.log(`  ✗ connectProvider threw: ${msg}`);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log("\n──────────────────────────────────────────────────");
console.log(`  Health:      ${healthOk ? "ok" : "FAIL"}`);
console.log(`  Tools:       ${toolsCount}`);
if (contextSnippet) {
  console.log(`  Context:     ${contextSnippet.replace(/\n/g, " ⏎ ")}…`);
}
console.log(`  Elapsed:     ${elapsed}s`);
console.log();

if (failures.length === 0) {
  console.log("  ✅ Siftable provider live test passed.\n");
  process.exit(0);
} else {
  console.error("  ❌ Failures:");
  for (const f of failures) console.error(`     - ${f}`);
  console.error();
  process.exit(1);
}
