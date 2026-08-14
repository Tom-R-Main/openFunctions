#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Intentionally resolves the TypeScript 6 compatibility API. TypeScript 7 is
// the compiler under test and does not own programmatic tooling in this repo.
const ts = require("typescript");

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const comparisonRoot = mkdtempSync(join(tmpdir(), "openfunction-ts-parity-"));
const ts7Root = join(comparisonRoot, "ts7");
const ts6Root = join(comparisonRoot, "ts6");

function emit(binary, outDir) {
  execFileSync(binary, ["--outDir", outDir, "--pretty", "false"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

function listFiles(root, directory = root) {
  return readdirSync(directory)
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory()
        ? listFiles(root, path)
        : [relative(root, path)];
    })
    .sort();
}

function normalizeDeclaration(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  const transformer = (context) => {
    const visit = (node) => {
      const visited = ts.visitEachChild(node, visit, context);
      if (
        ts.isLiteralTypeNode(visited) &&
        ts.isStringLiteral(visited.literal)
      ) {
        // The declaration emitters may choose different quote styles for
        // inferred string-literal types. Quote style is not semantic, so
        // rebuild the literal before comparing declarations.
        return ts.factory.createLiteralTypeNode(
          ts.factory.createStringLiteral(visited.literal.text),
        );
      }
      if (!ts.isUnionTypeNode(visited)) return visited;
      const sorted = [...visited.types].sort((left, right) =>
        printer
          .printNode(ts.EmitHint.Unspecified, left, sourceFile)
          .localeCompare(
            printer.printNode(ts.EmitHint.Unspecified, right, sourceFile),
          ),
      );
      return ts.factory.updateUnionTypeNode(visited, sorted);
    };
    return (node) => ts.visitNode(node, visit);
  };

  const transformed = ts.transform(sourceFile, [transformer]);
  try {
    return printer.printFile(transformed.transformed[0]);
  } finally {
    transformed.dispose();
  }
}

try {
  emit("node_modules/.bin/tsc", ts7Root);
  emit("node_modules/.bin/tsc6", ts6Root);

  const ts7Files = listFiles(ts7Root);
  const ts6Files = listFiles(ts6Root);
  assert.deepEqual(ts7Files, ts6Files, "TS7 and TS6 emitted different file sets");

  let declarationOrderDifferences = 0;
  for (const file of ts7Files) {
    const ts7 = readFileSync(join(ts7Root, file));
    const ts6 = readFileSync(join(ts6Root, file));
    if (ts7.equals(ts6)) continue;

    assert.ok(file.endsWith(".d.ts"), `Runtime artifact differs: ${file}`);
    const normalizedTs7 = normalizeDeclaration(ts7.toString("utf8"), file);
    const normalizedTs6 = normalizeDeclaration(ts6.toString("utf8"), file);
    assert.equal(
      normalizedTs7,
      normalizedTs6,
      `Declaration semantics differ: ${file}`,
    );
    declarationOrderDifferences += 1;
  }

  process.stdout.write(
    `TypeScript parity verified: ${ts7Files.length} artifacts, byte-identical runtime JavaScript, ` +
      `${declarationOrderDifferences} declaration-order-only difference(s).\n`,
  );
} finally {
  rmSync(comparisonRoot, { recursive: true, force: true });
}
