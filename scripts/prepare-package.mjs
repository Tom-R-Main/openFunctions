import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
if (process.argv.includes("--clean")) {
  await rm(new URL("dist/", root), { recursive: true, force: true });
} else {
  await mkdir(new URL("dist/system-prompts/", root), { recursive: true });
  await cp(new URL("system-prompts/", root), new URL("dist/system-prompts/", root), { recursive: true });
  await chmod(fileURLToPath(new URL("dist/src/cli.js", root)), 0o755);
}
