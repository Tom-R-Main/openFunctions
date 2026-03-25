/**
 * OpenFunction — Unified Chat Loop
 *
 * Shared interactive chat that works with any AI adapter.
 * Handles the tool call → execute → send result → continue cycle.
 */

import * as readline from "node:readline";
import type { AIAdapter, ChatMessage } from "./types.js";
import type { ToolRegistry } from "../registry.js";

/**
 * Start an interactive chat session with the given adapter.
 * The chat loop handles multi-round tool calling automatically.
 */
export async function startChat(
  adapter: AIAdapter,
  registry: ToolRegistry,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: ChatMessage[] = [];

  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║         openFunctions — AI Chat                  ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);
  console.log(`  Provider: ${adapter.name}`);
  console.log(`  Model:    ${adapter.model}`);
  console.log(`  Tools:    ${registry.listNames().length} registered\n`);
  console.log(`Type a message to chat. The AI can call your tools.`);
  console.log(`Commands: "reset" (clear history), "quit" (exit)\n`);

  const askQuestion = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "quit" || trimmed === "exit") {
        console.log("\nGoodbye!\n");
        rl.close();
        process.exit(0);
      }

      if (trimmed === "reset") {
        history.length = 0;
        console.log("\n  (conversation reset)\n");
        askQuestion();
        return;
      }

      history.push({ role: "user", content: trimmed });

      try {
        await runConversationTurn(adapter, registry, history);
      } catch (err) {
        console.error(
          `\n  Error: ${err instanceof Error ? err.message : err}\n`
        );
      }

      askQuestion();
    });
  };

  askQuestion();
}

/**
 * Run a single conversation turn, handling multi-round tool calls.
 */
async function runConversationTurn(
  adapter: AIAdapter,
  registry: ToolRegistry,
  history: ChatMessage[],
): Promise<void> {
  let maxRounds = 10;

  while (maxRounds-- > 0) {
    const response = await adapter.chat(history, registry);

    // If the AI wants to call a tool
    if (response.toolCall) {
      const { id, name, args } = response.toolCall;
      console.log(`\n  [Tool Call] ${name}(${JSON.stringify(args)})`);

      // Track the assistant's tool call request in history
      history.push({
        role: "assistant",
        content: JSON.stringify(args),
        toolCallId: id,
        toolName: name,
      });

      // Execute the tool
      const result = await registry.execute(name, args);
      const resultStr = JSON.stringify(result);
      console.log(`  [Result]   ${JSON.stringify(result.data ?? result.error)}`);

      // Send result back
      history.push({
        role: "tool",
        content: resultStr,
        toolCallId: id,
        toolName: name,
      });

      // Continue — the AI may call another tool or respond with text
      continue;
    }

    // Text response — we're done
    if (response.text) {
      history.push({ role: "assistant", content: response.text });
      console.log(`\n${adapter.name}: ${response.text}\n`);
    }

    return;
  }

  console.log("\n  (exceeded max tool calling rounds)\n");
}
