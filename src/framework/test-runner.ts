/**
 * OpenFunction — Test Runner
 *
 * Runs all tests defined in tool definitions via the `tests` array.
 * No test framework needed — just define tests alongside your tools.
 *
 * Usage:  npm test
 *
 * Tests live inside the tool definition:
 *
 *   defineTool({
 *     name: "my_tool",
 *     // ...
 *     tests: [
 *       {
 *         name: "does the thing",
 *         input: { title: "Test" },
 *         expect: { success: true, data: { title: "Test" } },
 *       },
 *     ],
 *   });
 */

import type { ToolDefinition, ToolTest, ToolResult } from "./types.js";
import type { ToolRegistry } from "./registry.js";

interface TestResult {
  tool: string;
  test: string;
  passed: boolean;
  error?: string;
}

/**
 * Run all tests for all registered tools.
 * Returns results and prints a summary to console.
 */
export async function runTests(registry: ToolRegistry): Promise<{
  passed: number;
  failed: number;
  skipped: number;
  results: TestResult[];
}> {
  const tools = registry.getAll();
  const results: TestResult[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // Count tools with and without tests
  const toolsWithTests = tools.filter((t) => t.tests && t.tests.length > 0);
  const toolsWithoutTests = tools.filter((t) => !t.tests || t.tests.length === 0);

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║         openFunctions — Test Runner              ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  if (toolsWithTests.length === 0) {
    console.log("  No tests found. Add tests to your tool definitions:\n");
    console.log("    defineTool({");
    console.log("      name: 'my_tool',");
    console.log("      // ...");
    console.log("      tests: [");
    console.log('        { name: "works", input: { ... }, expect: { success: true } },');
    console.log("      ],");
    console.log("    });\n");
    return { passed: 0, failed: 0, skipped: tools.length, results: [] };
  }

  const totalTests = toolsWithTests.reduce(
    (sum, t) => sum + (t.tests?.length ?? 0),
    0
  );
  console.log(
    `  Running ${totalTests} test${totalTests === 1 ? "" : "s"} across ${toolsWithTests.length} tool${toolsWithTests.length === 1 ? "" : "s"}...\n`
  );

  for (const tool of toolsWithTests) {
    console.log(`  ${tool.name}`);

    for (const test of tool.tests!) {
      const result = await runSingleTest(tool, test, registry);
      results.push(result);

      if (result.passed) {
        passed++;
        console.log(`    ✅ ${test.name}`);
      } else {
        failed++;
        console.log(`    ❌ ${test.name}`);
        console.log(`       ${result.error}`);
      }
    }
    console.log();
  }

  skipped = toolsWithoutTests.length;

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log("─".repeat(50));

  if (failed === 0) {
    console.log(
      `\n  ✅ All ${passed} test${passed === 1 ? "" : "s"} passed!`
    );
  } else {
    console.log(
      `\n  ❌ ${failed} failed, ${passed} passed`
    );
  }

  if (skipped > 0) {
    console.log(
      `  ⏭️  ${skipped} tool${skipped === 1 ? "" : "s"} have no tests`
    );
  }

  console.log();

  return { passed, failed, skipped, results };
}

/**
 * Run a single test case for a tool.
 */
async function runSingleTest(
  tool: ToolDefinition<any, any>,
  test: ToolTest,
  registry: ToolRegistry
): Promise<TestResult> {
  const base = { tool: tool.name, test: test.name };

  try {
    const result = await registry.execute(tool.name, test.input);

    // Check success/failure
    if (result.success !== test.expect.success) {
      if (test.expect.success) {
        return {
          ...base,
          passed: false,
          error: `Expected success but got error: "${result.error}"`,
        };
      } else {
        return {
          ...base,
          passed: false,
          error: `Expected failure but tool succeeded`,
        };
      }
    }

    // Check error message contains expected string
    if (test.expect.errorContains && result.error) {
      if (!result.error.includes(test.expect.errorContains)) {
        return {
          ...base,
          passed: false,
          error: `Error "${result.error}" doesn't contain "${test.expect.errorContains}"`,
        };
      }
    }

    // Check expected data fields
    if (test.expect.data && result.data) {
      const dataCheck = checkFields(
        test.expect.data,
        result.data as Record<string, unknown>
      );
      if (dataCheck) {
        return { ...base, passed: false, error: dataCheck };
      }
    }

    return { ...base, passed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, passed: false, error: `Threw: ${message}` };
  }
}

/**
 * Check that all expected fields exist with correct values in actual data.
 * Returns null if all match, or an error message if something differs.
 */
function checkFields(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>
): string | null {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];

    if (actualValue === undefined) {
      return `Missing field "${key}" in result.data`;
    }

    // Deep comparison for objects/arrays
    if (typeof expectedValue === "object" && expectedValue !== null) {
      if (typeof actualValue !== "object" || actualValue === null) {
        return `Field "${key}": expected object, got ${typeof actualValue}`;
      }
      const nested = checkFields(
        expectedValue as Record<string, unknown>,
        actualValue as Record<string, unknown>
      );
      if (nested) return nested;
    } else if (actualValue !== expectedValue) {
      return `Field "${key}": expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`;
    }
  }

  return null;
}
