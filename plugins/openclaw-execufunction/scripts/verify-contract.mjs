import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
);
const { default: plugin } = await import("../dist/index.js");
const registered = [];

plugin.register({
  config: {},
  registerTool(tool) {
    registered.push(tool.name);
  },
});

assert.deepEqual(
  registered.toSorted(),
  [...manifest.contracts.tools].toSorted(),
  "openclaw.plugin.json contracts.tools must match runtime registrations",
);

process.stdout.write(
  `Verified ${registered.length} Siftable OpenClaw tool contracts.\n`,
);
