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
import { RunExecutionError } from "./runs.js";

// ─── Server ────────────────────────────────────────────────────────────────

export async function serveChatAgent(
  agent: ChatAgent,
  options?: ServeOptions,
): Promise<void> {
  const port = options?.port ?? 3000;
  const host = options?.host ?? "localhost";
  const server = createChatAgentHttpServer(agent, options);

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

/** Build the HTTP server without binding it, for embedders and real-socket tests. */
export function createChatAgentHttpServer(
  agent: ChatAgent,
  options?: Pick<ServeOptions, "cors">,
): ReturnType<typeof createServer> {
  const cors = options?.cors ?? false;

  return createServer(async (req, res) => {
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
        await agent.resetAsync();
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /chat
      if (req.method === "POST" && url === "/chat") {
        const cancellation = abortOnDisconnect(req, res);
        try {
          const body = await readBody(req);
          const message = body.message as string | undefined;
          const threadId = body.threadId as string | undefined;
          if (!message || typeof message !== "string") {
            sendJson(res, 400, { error: "Missing 'message' string in request body" });
            return;
          }

          const result = await agent.chat(message, {
            threadId,
            signal: cancellation.signal,
          });
          if (!cancellation.signal.aborted) sendJson(res, 200, result);
        } finally {
          cancellation.dispose();
        }
        return;
      }

      // POST /chat/stream
      if (req.method === "POST" && url === "/chat/stream") {
        const cancellation = abortOnDisconnect(req, res);
        try {
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

          for await (const chunk of agent.chat(message, {
            stream: true,
            threadId,
            signal: cancellation.signal,
          })) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          if (!cancellation.signal.aborted) res.end();
        } finally {
          cancellation.dispose();
        }
        return;
      }

      // 404
      sendJson(res, 404, {
        error: "Not found",
        endpoints: ["GET /health", "POST /chat", "POST /chat/stream", "POST /reset"],
      });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const message = error instanceof Error ? error.message : "Internal server error";
      const hasPartialEffects = error instanceof RunExecutionError
        && error.toolEffects?.state === "partial";
      const failure = error instanceof RunExecutionError
        ? {
            error: message,
            run: error.run,
            ...(error.toolEffects === undefined ? {} : { toolEffects: error.toolEffects }),
            ...(hasPartialEffects ? { retryable: false } : {}),
            ...(error.toolEffects?.verificationRequired === undefined
              ? {}
              : { verificationRequired: error.toolEffects.verificationRequired }),
          }
        : { error: message };
      if (res.headersSent) {
        // SSE stream already started — emit an error frame and close cleanly
        // rather than calling writeHead a second time (which would throw
        // ERR_HTTP_HEADERS_SENT and crash the server).
        try {
          res.write(`event: error\ndata: ${JSON.stringify(failure)}\n\n`);
        } catch {
          // ignore — connection may already be torn down
        }
        res.end();
      } else {
        const status = hasPartialEffects ? 409 : 500;
        sendJson(res, status, failure);
      }
    }
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function abortOnDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("HTTP client disconnected"));
    }
  };
  const onResponseClose = () => {
    if (!res.writableFinished) abort();
  };
  req.once("aborted", abort);
  res.once("close", onResponseClose);
  if (req.aborted || res.destroyed) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      req.off("aborted", abort);
      res.off("close", onResponseClose);
    },
  };
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
    req.on("aborted", () => reject(new Error("HTTP client disconnected")));
    req.on("error", reject);
  });
}
