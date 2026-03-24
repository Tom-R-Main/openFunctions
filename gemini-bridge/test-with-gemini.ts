#!/usr/bin/env tsx
/**
 * OpenFunction — Test With Gemini
 *
 * Connects your tools to the Gemini API via function calling.
 * This proves that your MCP tools work with Google's AI too.
 *
 * Setup:
 *   1. Get a Gemini API key from https://aistudio.google.com/apikey
 *   2. Set it: export GEMINI_API_KEY=your-key-here
 *   3. Run:    npm run gemini
 *
 * What happens:
 *   - Your tools are converted to Gemini function declarations
 *   - You type a message to Gemini
 *   - Gemini can call your tools to answer
 *   - You see the tool calls and results in real time
 */

import * as readline from "node:readline";
import {
  getGeminiToolDeclarations,
  executeGeminiFunctionCall,
  printGeminiSchema,
} from "./bridge.js";

// ─── Config ────────────────────────────────────────────────────────────────

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

// ─── Types ─────────────────────────────────────────────────────────────────

interface GeminiContent {
  role: "user" | "model" | "function";
  parts: Array<{
    text?: string;
    functionCall?: { name: string; args: Record<string, unknown> };
    functionResponse?: { name: string; response: unknown };
  }>;
}

// ─── Gemini API Call ───────────────────────────────────────────────────────

async function callGemini(contents: GeminiContent[]): Promise<GeminiContent> {
  const body = {
    contents,
    tools: [getGeminiToolDeclarations()],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
    systemInstruction: {
      parts: [
        {
          text:
            "You are a helpful assistant with access to tools. " +
            "When the user asks you to do something, use the available tools to help them. " +
            "Always use tools when they're relevant — don't just describe what you would do.",
        },
      ],
    },
  };

  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];

  if (!candidate?.content) {
    throw new Error("No response from Gemini");
  }

  return candidate.content;
}

// ─── Conversation Loop ─────────────────────────────────────────────────────

async function chat(
  userMessage: string,
  history: GeminiContent[],
): Promise<{ reply: string; history: GeminiContent[] }> {
  // Add user message
  history.push({
    role: "user",
    parts: [{ text: userMessage }],
  });

  // Call Gemini (may involve multiple rounds of function calling)
  let maxRounds = 5;
  while (maxRounds-- > 0) {
    const response = await callGemini(history);
    history.push(response);

    // Check if Gemini wants to call a function
    const functionCall = response.parts.find((p) => p.functionCall);

    if (functionCall?.functionCall) {
      const { name, args } = functionCall.functionCall;
      console.log(`\n  [Tool Call] ${name}(${JSON.stringify(args)})`);

      // Execute the tool
      const result = await executeGeminiFunctionCall(name, args);
      console.log(`  [Result]   ${JSON.stringify(result.response.data)}`);

      // Send the result back to Gemini
      history.push({
        role: "function",
        parts: [
          {
            functionResponse: {
              name: result.name,
              response: result.response,
            },
          },
        ],
      });

      // Continue the loop — Gemini may call another function or respond
      continue;
    }

    // Gemini responded with text — we're done
    const textPart = response.parts.find((p) => p.text);
    return {
      reply: textPart?.text ?? "(no text response)",
      history,
    };
  }

  return { reply: "(exceeded max function calling rounds)", history };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error("\n  Missing GEMINI_API_KEY environment variable.\n");
    console.error("  Get one free at: https://aistudio.google.com/apikey");
    console.error("  Then run: export GEMINI_API_KEY=your-key-here\n");
    process.exit(1);
  }

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║       OpenFunction — Gemini Bridge Test          ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log(`  Model: ${MODEL}`);
  console.log(`  Your tools are registered as Gemini functions.\n`);

  // Show tool schema
  printGeminiSchema();

  // Start conversation
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let history: GeminiContent[] = [];

  const askQuestion = () => {
    rl.question("\nYou: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "quit" || trimmed === "exit") {
        console.log("\nGoodbye!\n");
        rl.close();
        process.exit(0);
      }

      if (trimmed === "reset") {
        history = [];
        console.log("\n  (conversation reset)\n");
        askQuestion();
        return;
      }

      try {
        const result = await chat(trimmed, history);
        history = result.history;
        console.log(`\nGemini: ${result.reply}`);
      } catch (err) {
        console.error(
          `\n  Error: ${err instanceof Error ? err.message : err}`,
        );
      }

      askQuestion();
    });
  };

  console.log('Type a message to chat with Gemini using your tools.');
  console.log('Try: "Create a study task for reading chapter 3 of Biology"');
  console.log('Commands: "reset" (clear history), "quit" (exit)\n');

  askQuestion();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
