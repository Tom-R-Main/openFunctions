import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { captureContracts } from './capture-contracts.mjs';
const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
const saved = JSON.parse(await readFile(new URL('../tool-contracts.json', import.meta.url), 'utf8'));
const actual = await captureContracts();
assert.deepEqual(manifest.contracts.tools.toSorted(), actual.tools.map((tool) => tool.name).toSorted(), 'Manifest names differ from credential-free runtime registration');
assert.deepEqual(saved, actual, 'Runtime schema digests or pinned SDK versions differ from the saved snapshot');
process.stdout.write(`Verified ${actual.tools.length} Siftable OpenClaw names and schema digests.\n`);
