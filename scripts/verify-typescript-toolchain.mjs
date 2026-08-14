#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const typescriptPackage = require("typescript/package.json");
const nativePackage = require("@typescript/native/package.json");
const ts = require("typescript");

function version(binary) {
  return execFileSync(binary, ["--version"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  }).trim();
}

assert.equal(
  packageJson.devDependencies["@typescript/native"],
  "npm:typescript@7.0.2",
);
assert.equal(
  packageJson.devDependencies.typescript,
  "npm:@typescript/typescript6@6.0.2",
);
assert.equal(packageJson.overrides["@typescript/old"], "npm:typescript@6.0.3");

assert.equal(nativePackage.version, "7.0.2");
assert.equal(typescriptPackage.version, "6.0.2");
assert.equal(ts.version, "6.0.3");
assert.equal(version("node_modules/.bin/tsc"), "Version 7.0.2");
assert.equal(version("node_modules/.bin/tsc6"), "Version 6.0.3");

assert.match(packageJson.scripts.build, /^tsc(?:\s|$)/u);
assert.match(packageJson.scripts.typecheck, /^tsc(?:\s|$)/u);
assert.match(packageJson.scripts["build:ts6"], /^tsc6(?:\s|$)/u);
assert.match(packageJson.scripts["typecheck:ts6"], /^tsc6(?:\s|$)/u);

const transpiled = ts.transpileModule("const value: number = 42;", {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
assert.match(transpiled.outputText, /const value = 42;/u);

process.stdout.write(
  "TypeScript contract verified: tsc=7.0.2, tsc6/compiler API=6.0.3.\n",
);
