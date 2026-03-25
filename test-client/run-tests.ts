#!/usr/bin/env tsx
/**
 * OpenFunction — Run All Tests
 * Run: npm test
 */

import { registry } from "../src/register-tools.js";
import { runTests } from "../src/framework/test-runner.js";

const { failed } = await runTests(registry);
process.exit(failed > 0 ? 1 : 0);
