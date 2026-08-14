import { readFile, writeFile } from "node:fs/promises";
import { TOOLS, isToolEnabled } from "@siftable/mcp-server";
import { isToolAllowedForTransport } from "@siftable/mcp-server/factory";

const manifestUrl = new URL("../openclaw.plugin.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
manifest.contracts.tools = TOOLS
  .filter((tool) => isToolEnabled(tool.name))
  .filter((tool) => isToolAllowedForTransport(tool.name, "hosted_remote"))
  .map((tool) => tool.name);
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Synced ${manifest.contracts.tools.length} Siftable tool contracts.\n`);
