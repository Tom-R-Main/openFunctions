import type { ToolDefinition, ToolResult } from "./types.js";

/** Trusted host context. References alone do not confer authority. */
export interface ToolExecutionContext {
  callId?: string;
  runId?: string;
  correlationId?: string;
  actor?: { kind: "local_user" | "agent" | "service" | "host"; id: string };
  scope?: { workspaceId?: string; projectId?: string; workspaceRoot?: string };
  signal?: AbortSignal;
  /** Absolute Unix epoch milliseconds. */
  deadline?: number;
  authorityGrantRefs?: readonly string[];
  authorizationContextId?: string;
  idempotencyKey?: string;
  expectedCapabilityDigest?: string;
}

export interface PolicyDecision {
  decision: "allow" | "deny" | "approval_required";
  reasonCodes?: readonly string[];
  /** Independently validated references, never copied from tool arguments. */
  authorityGrantRefs?: readonly string[];
  authorizationContextId?: string;
  expiresAt?: number;
}

export interface ExecutionPolicy {
  authorize(input: {
    toolSnapshot: ToolDefinition;
    params: Readonly<Record<string, unknown>>;
    context: Readonly<ToolExecutionContext>;
  }): PolicyDecision | Promise<PolicyDecision>;
}

export type ReplayPolicy = "never" | "read_only" | "provider_keyed";
export type ExecutionMode = "parallel-safe" | "exclusive";

export interface ToolExecutionReceipt {
  schemaVersion: 1;
  executionId: string;
  callId?: string;
  runId?: string;
  correlationId?: string;
  toolName: string;
  capabilityDigest?: string;
  actor?: ToolExecutionContext["actor"];
  scope?: ToolExecutionContext["scope"];
  admission: "allowed" | "rejected";
  reasonCodes: string[];
  authorityGrantRefs: string[];
  authorizationContextId?: string;
  phase: "not_started" | "started" | "settled";
  executionOutcome: "succeeded" | "failed" | "unknown";
  requestedAt: number;
  startedAt?: number;
  finishedAt?: number;
  cancellationObserved: boolean;
  deadlineObserved: boolean;
  inputDigest?: string;
  resultDigest?: string;
  idempotency: { disposition: "not_requested" | "unconfirmed" | "provider_confirmed"; keyDigest?: string };
  replayPolicy: ReplayPolicy;
  artifactRefs: readonly string[];
  verification: { state: "not_requested" | "pending" | "passed" | "failed" | "inconclusive"; evidenceRefs: readonly string[] };
  errorCategory?: string;
  reconciliation?: string;
}

export interface ToolExecution {
  result: ToolResult;
  modelContent: string;
  outcome: ToolExecutionReceipt["executionOutcome"];
  receipt: ToolExecutionReceipt;
}

export interface ExecutionJournalEvent {
  type: "requested" | "admitted" | "rejected" | "started" | "settled";
  executionId: string;
  data: Record<string, unknown>;
}
export interface ExecutionJournalSink {
  record(event: ExecutionJournalEvent): void | Promise<void>;
  /** Trusted final-result observer; runs before reservation release, even if another journal failed. */
  onSettled?(execution: Readonly<ToolExecution>): void | Promise<void>;
}
export interface ExecutionLogger {
  debug?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}
export interface ToolExecutorOptions {
  mode?: "local" | "governed";
  policy?: ExecutionPolicy;
  journal?: ExecutionJournalSink;
  logger?: ExecutionLogger;
  clock?: () => number;
  maxParallel?: number;
}
export interface RegistrySelection {
  names?: readonly string[];
  tags?: readonly string[];
  capabilities?: readonly string[];
  level?: "read" | "write" | "full";
  filter?: (tool: ToolDefinition) => boolean;
}
