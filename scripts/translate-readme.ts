#!/usr/bin/env tsx
/**
 * Translate README.md into all supported ExecuFunction locales
 * using Google AI Studio (Gemini).
 *
 * Usage:
 *   GEMINI_API_KEY=... npx tsx scripts/translate-readme.ts
 *   npx tsx scripts/translate-readme.ts --locale te   # single locale
 */

import "../src/framework/env.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const LOCALES: Record<string, string> = {
  ar: "Arabic",
  bn: "Bengali",
  de: "German",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  id: "Indonesian",
  ja: "Japanese",
  ko: "Korean",
  nl: "Dutch",
  pa: "Punjabi",
  pl: "Polish",
  "pt-BR": "Brazilian Portuguese",
  ru: "Russian",
  sv: "Swedish",
  te: "Telugu",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  yue: "Cantonese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
};

const MODEL = "gemini-2.5-flash";

async function translateReadme(
  readmeContent: string,
  locale: string,
  languageName: string,
  apiKey: string,
): Promise<string> {
  const systemPrompt = `You are a professional translator. Translate the following GitHub README from English to ${languageName}.

Rules:
- Translate all prose, headings, descriptions, comments, and table content.
- Keep ALL code blocks, code snippets, commands, URLs, file paths, and technical identifiers (function names, variable names, package names) EXACTLY as-is in English.
- Keep HTML tags, markdown formatting, and anchor links EXACTLY as-is.
- Keep brand names (openFunctions, ExecuFunction, MCP, Claude, Gemini, ChatGPT, Grok, OpenRouter, GitHub) in English.
- Translate markdown table headers and cell descriptions, but keep code/technical values unchanged.
- Translate inline code descriptions/comments within code blocks (the // comments) but keep the code itself unchanged.
- The translation should sound natural and professional in ${languageName}, not like a word-for-word translation.
- Preserve the exact markdown structure (headers, lists, tables, code fences, links).
- At the very top, add a language selector line: \`[English](../README.md) | [${languageName}](README.${locale}.md)\``;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n---\n\n${readmeContent}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 16384 },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text;
  if (!text) throw new Error("No translation returned");

  return text;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_API_KEY;
  if (!apiKey) {
    console.error("Set GEMINI_API_KEY or GOOGLE_AI_STUDIO_API_KEY");
    process.exit(1);
  }

  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  const outDir = join(ROOT, "docs", "i18n");
  mkdirSync(outDir, { recursive: true });

  // Parse args
  const args = process.argv.slice(2);
  const localeArg = args.indexOf("--locale");
  const selectedLocale = localeArg !== -1 ? args[localeArg + 1] : null;

  const localesToProcess = selectedLocale
    ? { [selectedLocale]: LOCALES[selectedLocale] || selectedLocale }
    : LOCALES;

  const total = Object.keys(localesToProcess).length;
  let done = 0;

  // Process 3 at a time to stay within rate limits
  const entries = Object.entries(localesToProcess);
  const concurrency = 3;

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async ([locale, name]) => {
        try {
          console.log(`  [${++done}/${total}] Translating to ${name} (${locale})...`);
          const translated = await translateReadme(readme, locale, name, apiKey);
          const outPath = join(outDir, `README.${locale}.md`);
          writeFileSync(outPath, translated);
          console.log(`  ✅ ${locale} → ${outPath}`);
        } catch (e) {
          console.error(`  ❌ ${locale}: ${e instanceof Error ? e.message : e}`);
        }
      }),
    );
  }

  console.log(`\nDone. ${done} translations in docs/i18n/`);
}

main();
