import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import plugin from '../dist/index.js';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const tools = [];
plugin.register({ config: {}, registerTool(tool) { tools.push(tool); } });
assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
const actual = {
  schemaVersion: 1,
  tools: tools.map((tool) => ({ name: tool.name, inputSchemaDigest: createHash('sha256').update(JSON.stringify(canonical(tool.parameters))).digest('hex') })).sort((a, b) => a.name.localeCompare(b.name)),
};
const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
assert.deepEqual(manifest.contracts.tools.toSorted(), actual.tools.map((tool) => tool.name).toSorted(), 'Manifest names differ from actual SDK registration');
const snapshotUrl = new URL('../tool-contracts.json', import.meta.url);
if (process.argv.includes('--write')) await writeFile(snapshotUrl, `${JSON.stringify(actual, null, 2)}\n`);
else assert.deepEqual(JSON.parse(await readFile(snapshotUrl, 'utf8')), actual, 'Tool input schema changed; regenerate the reviewed contract snapshot');
process.stdout.write(`Verified ${tools.length} static plugin names and schema digests.\n`);
