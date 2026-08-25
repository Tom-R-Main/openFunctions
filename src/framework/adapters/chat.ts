/**
 * OpenFunction — Unified Chat Loop
 *
 * Shared interactive chat that works with any AI adapter.
 * Handles the tool call → execute → send result → continue cycle.
 */

import * as readline from "node:readline";
import type { AIAdapter, AdapterSessionState, ChatMessage } from "./types.js";
import { validatedAdapterToolCalls } from "./types.js";
import type { ToolRegistry } from "../registry.js";
import { normalizeToolResult, uncertainToolExecution } from "../tool.js";

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

      // Snapshot history length so a failed turn doesn't leave an
      // orphan user message — see ChatAgent for the same pattern.
      const historyLengthBefore = history.length;
      history.push({ role: "user", content: trimmed });

      try {
        await runConversationTurn(adapter, registry, history);
      } catch (err) {
        // Once a tool receipt exists, the turn is part of the durable model
        // context even when execution certainty is unknown or a later adapter
        // call fails. Keep the call/result pair so the next user turn can see
        // what already happened; only roll back failures with no tool receipt.
        const hasToolReceipt = history
          .slice(historyLengthBefore)
          .some((message) => message.role === "tool");
        if (!hasToolReceipt) history.length = historyLengthBefore;
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
  let sessionState: AdapterSessionState | undefined;

  while (maxRounds-- > 0) {
    const response = await adapter.chat(
      history,
      registry,
      sessionState === undefined ? undefined : { sessionState },
    );
    sessionState = response.sessionState;

    const calls = validatedAdapterToolCalls(response);
    if (calls.length > 0) {
      for (const call of calls) {
        console.log(`\n  [Tool Call] ${call.name}(${JSON.stringify(call.args)})`);
      }
      history.push(calls.length === 1
        ? {
            role: "assistant",
            content: JSON.stringify(calls[0].args),
            toolCallId: calls[0].id,
            toolName: calls[0].name,
            ...(response.thinking && { thinkingBlocks: response.thinking }),
            ...(response.providerReplay === undefined
              ? {}
              : { providerReplay: response.providerReplay }),
          }
        : {
            role: "assistant",
            content: "",
            toolCalls: calls,
            ...(response.thinking && { thinkingBlocks: response.thinking }),
            ...(response.providerReplay === undefined
              ? {}
              : { providerReplay: response.providerReplay }),
          });

      const settledResults = await Promise.allSettled(
        calls.map((call) => registry.execute(call.name, call.args)),
      );
      const executions = settledResults.map((settled, index) =>
        settled.status === "rejected"
          ? uncertainToolExecution(settled.reason)
          : normalizeToolResult(calls[index].name, settled.value)
      );
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        const execution = executions[index];
        const result = execution.result;
        console.log(`  [Result]   ${JSON.stringify(result.data ?? result.error)}`);
        history.push({
          role: "tool",
          content: execution.modelContent,
          toolCallId: call.id,
          toolName: call.name,
        });
      }
      if (executions.some((execution) => execution.outcome === "unknown")) {
        throw new Error("Tool execution outcome is unknown; verify side effects before retrying");
      }

      // Continue — the AI may call another tool or respond with text
      continue;
    }

    // Text response — we're done
    if (response.text) {
      history.push({
        role: "assistant",
        content: response.text,
        ...(response.providerReplay === undefined
          ? {}
          : { providerReplay: response.providerReplay }),
      });
      console.log(`\n${adapter.name}: ${response.text}\n`);
    }

    return;
  }

  console.log("\n  (exceeded max tool calling rounds)\n");
}
