/**
 * ChatAgent — HTTP Server
 *
 * Minimal HTTP server using node:http. No dependencies.
 * Lazy-imported by ChatAgent.serve() so it adds zero overhead when unused.
 *
 * Endpoints:
 *   POST /chat        — { message, threadId? } → ChatResult JSON
 *   POST /chat/stream — { message, threadId? } → SSE stream of ChatStreamChunk
 *   GET  /health      — { ok, name, provider, model }
 *   POST /reset       — resets conversation history
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatAgent, ServeOptions } from "./chat-agent-types.js";

// ─── Server ────────────────────────────────────────────────────────────────

export async function serveChatAgent(
  agent: ChatAgent,
  options?: ServeOptions,
): Promise<void> {
  const port = options?.port ?? 3000;
  const host = options?.host ?? "localhost";
  const cors = options?.cors ?? false;

  const server = createServer(async (req, res) => {
    // CORS
    if (cors) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    try {
      const url = req.url ?? "/";

      // GET /health
      if (req.method === "GET" && url === "/health") {
        sendJson(res, 200, {
          ok: true,
          name: agent.name,
          provider: agent.provider,
          model: agent.model,
        });
        return;
      }

      // POST /reset
      if (req.method === "POST" && url === "/reset") {
        agent.reset();
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /chat
      if (req.method === "POST" && url === "/chat") {
        const body = await readBody(req);
        const message = body.message as string | undefined;
        const threadId = body.threadId as string | undefined;
        if (!message || typeof message !== "string") {
          sendJson(res, 400, { error: "Missing 'message' string in request body" });
          return;
        }

        const result = await agent.chat(message, { threadId });
        sendJson(res, 200, result);
        return;
      }

      // POST /chat/stream
      if (req.method === "POST" && url === "/chat/stream") {
        const body = await readBody(req);
        const message = body.message as string | undefined;
        const threadId = body.threadId as string | undefined;
        if (!message || typeof message !== "string") {
          sendJson(res, 400, { error: "Missing 'message' string in request body" });
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        for await (const chunk of agent.chat(message, { stream: true, threadId })) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }

        res.end();
        return;
      }

      // 404
      sendJson(res, 404, {
        error: "Not found",
        endpoints: ["GET /health", "POST /chat", "POST /chat/stream", "POST /reset"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      sendJson(res, 500, { error: message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`\n🚀 ChatAgent server running at http://${host}:${port}`);
      console.log(`   Agent:    ${agent.name}`);
      console.log(`   Provider: ${agent.provider}`);
      console.log(`   Model:    ${agent.model}\n`);
      console.log(`   POST /chat        — send a message`);
      console.log(`   POST /chat/stream — stream a response (SSE)`);
      console.log(`   GET  /health      — health check`);
      console.log(`   POST /reset       — reset conversation\n`);
      resolve();
    });
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON in request body"));
      }
    });
    req.on("error", reject);
  });
}
