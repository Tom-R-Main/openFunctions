import { readFile, writeFile } from 'node:fs/promises';
import { captureContracts } from './capture-contracts.mjs';
const contract = await captureContracts();
const manifestUrl = new URL('../openclaw.plugin.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
manifest.contracts.tools = contract.tools.map((tool) => tool.name);
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(new URL('../tool-contracts.json', import.meta.url), `${JSON.stringify(contract, null, 2)}\n`);
process.stdout.write(`Synced ${contract.tools.length} runtime names and schema digests.\n`);
