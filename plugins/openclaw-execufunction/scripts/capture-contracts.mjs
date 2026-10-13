import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function schemaDigest(schema) {
  return createHash('sha256').update(JSON.stringify(canonical(schema))).digest('hex');
}
export async function captureContracts() {
  const { default: plugin } = await import('../dist/index.js');
  const tools = [];
  plugin.register({ config: {}, registerTool(tool) { tools.push(tool); }, registerService() {} });
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, 'Duplicate runtime tool names');
  assert.ok(tools.every((tool) => !tool.name.startsWith('work_session_')), 'Embedded sessions need a validated principal and store');
  const version = async (name, entry) => {
    let directory = dirname(fileURLToPath(import.meta.resolve(entry)));
    for (;;) {
      try {
        const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (pkg.name === name) return pkg.version;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Package version unavailable for ${name}`);
      directory = parent;
    }
  };
  return {
    schemaVersion: 1,
    sdk: { openclaw: await version('openclaw', 'openclaw/plugin-sdk/plugin-entry'), siftable: await version('@siftable/mcp-server', '@siftable/mcp-server/exfClient'), openfunction: await version('openfunction', 'openfunction/framework/registry') },
    tools: tools.map((tool) => ({ name: tool.name, inputSchemaDigest: schemaDigest(tool.parameters) })).sort((a,b) => a.name.localeCompare(b.name)),
  };
}
