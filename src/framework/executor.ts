/** One execution boundary for direct calls, hosts, and bounded work. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { digestJson, snapshotJson } from "./session.js";
import { normalizeToolResult, uncertainToolExecution } from "./tool.js";
import { ToolScheduler, type BoundToolScheduler } from "./tool-scheduler.js";
import { validateParams, formatValidationErrors } from "./validate.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import type {
  ExecutionJournalSink, ExecutionMode, ExecutionPolicy, PolicyDecision,
  ToolExecution, ToolExecutionContext, ToolExecutionReceipt, ToolExecutorOptions,
} from "./execution-types.js";

export type * from "./execution-types.js";
type ResolveTool = (name: string) => ToolDefinition | undefined;
interface InvocationServices { resolve?: ResolveTool; policies?: readonly ExecutionPolicy[]; lifecycle?: ExecutionJournalSink; catalogDigest?: string; }
interface ActiveInvocation {
  context: ToolExecutionContext;
  bound: BoundToolScheduler;
  childAllowed: boolean;
  policies: readonly ExecutionPolicy[];
}

/** The digest binds the advertised specification, rather than mutable references. */
export function capabilityDigest(tool: ToolDefinition): string {
  return digestJson({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null, annotations: tool.annotations ?? null,
    metadata: tool._meta ?? null,
    tags: tool.tags ?? [], contract: tool.contract ?? null,
    replayPolicy: tool.replayPolicy ?? "never",
    executionMode: typeof tool.executionMode === "function"
      ? Function.prototype.toString.call(tool.executionMode) : tool.executionMode ?? "exclusive",
    handler: Function.prototype.toString.call(tool.handler),
  });
}

function freezeTool(tool: ToolDefinition): ToolDefinition {
  return Object.freeze({ ...tool,
    inputSchema: snapshotJson(tool.inputSchema) as ToolDefinition["inputSchema"],
    ...(tool.outputSchema ? { outputSchema: snapshotJson(tool.outputSchema) as ToolDefinition["inputSchema"] } : {}),
    ...(tool.annotations ? { annotations: snapshotJson(tool.annotations) } : {}),
    ...(tool._meta ? { _meta: snapshotJson(tool._meta) } : {}),
    ...(tool.contract ? { contract: snapshotJson(tool.contract) } : {}),
    ...(tool.tags ? { tags: Object.freeze([...tool.tags]) as unknown as string[] } : {}),
  });
}
function copyContext(context: ToolExecutionContext): ToolExecutionContext {
  return Object.freeze({ ...context,
    ...(context.actor ? { actor: Object.freeze({ ...context.actor }) } : {}),
    ...(context.scope ? { scope: Object.freeze({ ...context.scope }) } : {}),
    ...(context.authorityGrantRefs ? { authorityGrantRefs: Object.freeze([...context.authorityGrantRefs]) } : {}),
  });
}
function effectiveContext(parent: ToolExecutionContext, child: ToolExecutionContext): ToolExecutionContext {
  for (const key of ["actor", "scope"] as const) {
    if (child[key] && (parent[key] === undefined || digestJson(child[key]) !== digestJson(parent[key]))) {
      throw new Error("Nested execution cannot change actor or scope");
    }
  }
  if (child.authorityGrantRefs?.some(ref => !parent.authorityGrantRefs?.includes(ref))) {
    throw new Error("Nested execution cannot widen authority");
  }
  if (child.authorizationContextId && child.authorizationContextId !== parent.authorizationContextId) {
    throw new Error("Nested execution cannot change authorization context");
  }
  const signals = [parent.signal, child.signal].filter((signal): signal is AbortSignal => signal !== undefined);
  const deadlines = [parent.deadline, child.deadline].filter((deadline): deadline is number => deadline !== undefined);
  const { callId: _call, expectedCapabilityDigest: _digest, idempotencyKey: _key, ...inherited } = parent;
  return copyContext({ ...inherited, ...child,
    actor: parent.actor, scope: parent.scope,
    authorityGrantRefs: child.authorityGrantRefs ?? parent.authorityGrantRefs,
    authorizationContextId: parent.authorizationContextId,
    ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
    ...(deadlines.length ? { deadline: Math.min(...deadlines) } : {}),
  });
}

export class ToolExecutor {
  readonly options: Readonly<ToolExecutorOptions>;
  private readonly scheduler: ToolScheduler;
  private readonly renewalScheduler = new ToolScheduler({ maxParallel: 1 });
  private readonly active = new AsyncLocalStorage<ActiveInvocation>();
  private readonly clock: () => number;
  constructor(private readonly resolveTool: ResolveTool, options: ToolExecutorOptions = {}) {
    if (options.mode === "governed" && !options.policy) throw new Error("Governed execution requires a policy");
    this.options = Object.freeze({ ...options });
    this.clock = options.clock ?? Date.now;
    this.scheduler = new ToolScheduler({ maxParallel: options.maxParallel });
  }

  /** Trusted in-process capability; absent from all serializable contexts. */
  withChildExecution<T>(callback: () => Promise<T>): Promise<T> {
    const parent = this.active.getStore();
    if (!parent) return Promise.reject(new Error("Child execution requires an active invocation"));
    return this.active.run({ ...parent, childAllowed: true }, callback);
  }

  /** Bind one adapter-owned renewal definition; ordinary calls cannot select this lane. */
  createRenewalRunner(tool: ToolDefinition, policies: readonly ExecutionPolicy[] = [], lifecycle?: ExecutionJournalSink) {
    const frozen = freezeTool(tool);
    return (params: Record<string, unknown>, context: ToolExecutionContext = {}) =>
      this.invoke(tool.name, params, context, { resolve: name => name === frozen.name ? frozen : undefined, policies, lifecycle }, true);
  }

  executeDetailed(name: string, params: Record<string, unknown>, context: ToolExecutionContext = {}, services: InvocationServices = {}): Promise<ToolExecution> {
    return this.invoke(name, params, context, services, false);
  }

  private async invoke(name: string, input: Record<string, unknown>, supplied: ToolExecutionContext, services: InvocationServices, renewal: boolean): Promise<ToolExecution> {
    const parent = renewal ? undefined : this.active.getStore();
    let context = copyContext(supplied);
    let contextError: string | undefined;
    if (parent) {
      try {
        if (!parent.childAllowed) throw new Error("Nested execution requires withChildExecution");
        context = effectiveContext(parent.context, context);
      } catch (error) { contextError = error instanceof Error ? error.message : "Invalid child context"; }
    }
    const policies = [...(this.options.policy ? [this.options.policy] : []), ...(parent?.policies ?? []), ...(services.policies ?? [])];
    const uniquePolicies = [...new Set(policies)];
    const receipt: ToolExecutionReceipt = {
      schemaVersion: 1, executionId: randomUUID(), toolName: name,
      ...(context.callId ? { callId: context.callId } : {}),
      ...(context.runId ? { runId: context.runId } : {}),
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      ...(context.actor ? { actor: context.actor } : {}), ...(context.scope ? { scope: context.scope } : {}),
      admission: "rejected", reasonCodes: [], authorityGrantRefs: [], phase: "not_started",
      executionOutcome: "failed", requestedAt: this.clock(), cancellationObserved: false, deadlineObserved: false,
      idempotency: context.idempotencyKey ? { disposition: "unconfirmed", keyDigest: digestJson(context.idempotencyKey) } : { disposition: "not_requested" },
      replayPolicy: "never", artifactRefs: [], verification: { state: "not_requested", evidenceRefs: [] },
    };
    const sinks = [...new Set([this.options.journal, services.lifecycle].filter((sink): sink is ExecutionJournalSink => sink !== undefined))];
    let journalState: "none" | "requested" | "admitted" | "started" = "none";
    let handlerEntered = false;
    const record = async (type: "requested" | "admitted" | "rejected" | "started" | "settled", data: Record<string, unknown>) => {
      for (const sink of sinks) await sink.record({ type, executionId: receipt.executionId, data });
      if (type === "requested" || type === "admitted" || type === "started") journalState = type;
    };
    const finish = async (normalized: ReturnType<typeof normalizeToolResult>, persist = true): Promise<ToolExecution> => {
      receipt.finishedAt = this.clock();
      receipt.cancellationObserved ||= !!context.signal?.aborted;
      receipt.deadlineObserved = context.deadline !== undefined && this.clock() >= context.deadline;
      receipt.executionOutcome = normalized.outcome;
      receipt.resultDigest = digestJson(normalized.result);
      const snapshot = snapshotJson(receipt) as ToolExecutionReceipt;
      if (persist && journalState !== "none") {
        try {
          await record(journalState === "requested" ? "rejected" : "settled", { receipt: snapshot, result: normalized.result, modelContent: normalized.modelContent });
        } catch {
          receipt.errorCategory = "journal_delivery_failed";
          receipt.reconciliation = receipt.startedAt === undefined
            ? "Admission was not durably delivered; no handler was invoked."
            : "Result persistence failed after dispatch; reconcile effects before any retry.";
          if (receipt.startedAt !== undefined) {
            receipt.phase = "started";
            normalized = normalizeToolResult(name, { ...normalized.result, success: false,
              error: "Result persistence failed after dispatch; execution outcome is unknown", executionOutcome: "unknown" });
            receipt.executionOutcome = "unknown";
            receipt.resultDigest = digestJson(normalized.result);
          }
          this.options.logger?.error?.(`Execution ${receipt.executionId}: journal delivery failed`);
        }
      }
      const execution = { ...normalized, receipt: snapshotJson(receipt) as ToolExecutionReceipt };
      const observers = sinks.filter(sink => sink.onSettled !== undefined);
      const observed = observers.length ? snapshotJson(execution) as ToolExecution : undefined;
      const observerErrors: unknown[] = [];
      for (const sink of observers) {
        try { await sink.onSettled!(observed!); } catch (error) { observerErrors.push(error); }
      }
      if (observerErrors.length) throw new AggregateError(observerErrors, "Execution result observation failed");
      return execution;
    };
    const reject = (reason: string, error = reason === "cancelled_before_start" ? "Tool invocation aborted before dispatch" : reason) => {
      receipt.admission = "rejected";
      receipt.reasonCodes = [reason];
      receipt.phase = "not_started";
      return finish(normalizeToolResult(name, { success: false, error, executionOutcome: "failed" }));
    };
    const interruption = () => context.signal?.aborted ? "cancelled_before_start"
      : context.deadline !== undefined && (!Number.isFinite(context.deadline) || this.clock() >= context.deadline) ? "deadline_before_start" : undefined;
    const resolve = services.resolve ?? this.resolveTool;
    let tool: ToolDefinition | undefined;
    let source: ToolDefinition | undefined;
    let params: Record<string, unknown>;
    try {
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool parameters must be a JSON object");
      params = snapshotJson(input, "tool parameters") as Record<string, unknown>;
      receipt.inputDigest = digestJson(params);
      source = resolve(name);
      if (source) {
        tool = freezeTool(source);
        receipt.capabilityDigest = capabilityDigest(tool);
        receipt.replayPolicy = tool.replayPolicy ?? "never";
        if (tool.contract?.requiredVerification?.length) receipt.verification.state = "pending";
      }
      await record("requested", {
        toolName: name,
        ...(receipt.callId ? { callId: receipt.callId } : {}),
        ...(receipt.runId ? { runId: receipt.runId } : {}),
        ...(receipt.correlationId ? { correlationId: receipt.correlationId } : {}),
        ...(receipt.inputDigest ? { inputDigest: receipt.inputDigest } : {}),
        ...(receipt.capabilityDigest ? { capabilityDigest: receipt.capabilityDigest } : {}),
      });
    } catch {
      return reject(journalState === "none" && receipt.inputDigest ? "journal_or_catalog_failed" : "invalid_parameters", "Tool admission failed before dispatch: invalid parameters, catalog, or journal");
    }
    if (contextError) return reject("invalid_nested_execution", contextError);
    if (!tool) return reject("unknown_tool", `Unknown tool: "${name}"`);
    let invalid;
    try { invalid = validateParams(params!, tool.inputSchema); } catch { return reject("invalid_schema", "Tool schema could not be validated"); }
    if (invalid.length) return reject("invalid_arguments", formatValidationErrors(name, invalid));
    const checkCapability = () => {
      const current = resolve(name);
      return !current || current.handler !== tool!.handler || capabilityDigest(current) !== receipt.capabilityDigest
        || (services.catalogDigest !== undefined && services.catalogDigest !== receipt.capabilityDigest)
        || (context.expectedCapabilityDigest !== undefined && context.expectedCapabilityDigest !== receipt.capabilityDigest);
    };
    const authorize = async (): Promise<PolicyDecision> => {
      let decision: PolicyDecision = { decision: "allow", authorityGrantRefs: [], reasonCodes: ["local_execution"] };
      for (const policy of uniquePolicies) {
        const next = await policy.authorize({ toolSnapshot: tool!, params: params!, context });
        if (!next || !["allow", "deny", "approval_required"].includes(next.decision)) return { decision: "deny", reasonCodes: ["invalid_policy_decision"] };
        if (next.decision !== "allow") return next;
        // Every constituent authority must still be valid. A later visibility
        // policy cannot extend the original grant's expiry or erase its binding.
        if (next.expiresAt !== undefined && (!Number.isFinite(next.expiresAt) || next.expiresAt <= this.clock())) return { decision: "deny", reasonCodes: ["expired_authority"] };
        const expiries = [decision.expiresAt, next.expiresAt].filter((expiry): expiry is number => expiry !== undefined);
        decision = { ...decision, ...next,
          reasonCodes: [...new Set([...(decision.reasonCodes ?? []), ...(next.reasonCodes ?? [])])],
          authorityGrantRefs: [...new Set([...(decision.authorityGrantRefs ?? []), ...(next.authorityGrantRefs ?? [])])],
          ...(expiries.length ? { expiresAt: Math.min(...expiries) } : {}),
        };
      }
      if (decision.expiresAt !== undefined && (!Number.isFinite(decision.expiresAt) || decision.expiresAt <= this.clock())) return { decision: "deny", reasonCodes: ["expired_authority"] };
      if (tool!.contract?.requiresAuthority && !(decision.authorityGrantRefs?.length || decision.authorizationContextId)) return { decision: "approval_required", reasonCodes: ["authority_required"] };
      return decision;
    };
    try {
      const stopped = interruption();
      if (stopped) return reject(stopped);
      if (checkCapability()) return reject("stale_capability");
      const initial = await authorize();
      if (initial.decision !== "allow") return reject(initial.decision, initial.reasonCodes?.join(", ") || initial.decision);
      let mode: ExecutionMode = "exclusive";
      try { const selected = typeof tool.executionMode === "function" ? tool.executionMode(params!) : tool.executionMode; if (selected === "parallel-safe") mode = selected; } catch { /* Unclassified tools remain exclusive. */ }
      const dispatch = async (bound: BoundToolScheduler): Promise<ToolExecution> => {
        const stopped = interruption();
        if (stopped) return reject(stopped);
        if (checkCapability()) return reject("stale_capability");
        const decision = await authorize();
        if (decision.decision !== "allow") return reject(decision.decision, decision.reasonCodes?.join(", ") || decision.decision);
        receipt.admission = "allowed";
        receipt.reasonCodes = [...(decision.reasonCodes ?? [])];
        receipt.authorityGrantRefs = [...(decision.authorityGrantRefs ?? [])];
        if (decision.authorizationContextId) receipt.authorizationContextId = decision.authorizationContextId;
        await record("admitted", { receipt: snapshotJson(receipt) });
        const finalStop = interruption() ?? (decision.expiresAt !== undefined && decision.expiresAt <= this.clock() ? "expired_authority" : undefined);
        if (finalStop) return reject(finalStop);
        receipt.phase = "started";
        receipt.executionOutcome = "unknown";
        receipt.startedAt = this.clock();
        await record("started", { receipt: snapshotJson(receipt) });
        // Journal I/O is an async boundary. Revocation can arrive while the
        // durable intent is being saved, before any handler has entered.
        const finalAuthority = await authorize();
        const bindingChanged = digestJson({ refs: decision.authorityGrantRefs ?? [], context: decision.authorizationContextId })
          !== digestJson({ refs: finalAuthority.authorityGrantRefs ?? [], context: finalAuthority.authorizationContextId });
        const afterStartStop = interruption()
          ?? (finalAuthority.decision !== "allow" ? finalAuthority.decision : undefined)
          ?? (bindingChanged ? "authority_binding_changed" : undefined)
          ?? ([decision.expiresAt, finalAuthority.expiresAt].some(expiry => expiry !== undefined && expiry <= this.clock()) ? "expired_authority" : undefined);
        if (afterStartStop || checkCapability()) {
          receipt.startedAt = undefined;
          return reject(afterStartStop ?? "stale_capability");
        }
        const controller = new AbortController();
        const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (context.deadline !== undefined) {
          timer = setTimeout(() => controller.abort(new DOMException("Execution deadline exceeded", "TimeoutError")), Math.max(0, Math.min(context.deadline - this.clock(), 2_147_483_647)));
          timer.unref?.();
        }
        const boundContext = copyContext({ ...context, signal, authorityGrantRefs: receipt.authorityGrantRefs, ...(receipt.authorizationContextId ? { authorizationContextId: receipt.authorizationContextId } : {}) });
        let normalized;
        try {
          normalized = await this.active.run({ context: boundContext, bound, childAllowed: false, policies: uniquePolicies }, async () => {
            handlerEntered = true;
            try { return normalizeToolResult(name, await tool!.handler(params!, boundContext)); }
            catch (error) {
              this.options.logger?.error?.(`Execution ${receipt.executionId}: handler threw; outcome unknown. Input keys: ${Object.keys(params!).sort().join(", ") || "(none)"}`);
              return normalizeToolResult(name, { success: false,
                error: error instanceof Error ? error.message : "Unknown tool error",
                executionOutcome: "unknown" });
            }
          });
        } finally { if (timer !== undefined) clearTimeout(timer); }
        receipt.cancellationObserved = signal.aborted;
        if (normalized.result.content !== undefined || normalized.result.structuredContent !== undefined || normalized.result._meta !== undefined) {
          const content = normalized.result.content ?? [{ type: "text" as const, text: normalized.modelContent }];
          const checked = CallToolResultSchema.safeParse({ content,
            ...(normalized.result.structuredContent !== undefined ? { structuredContent: normalized.result.structuredContent } : {}),
            ...(normalized.result._meta !== undefined ? { _meta: normalized.result._meta } : {}),
          });
          if (!checked.success) {
            normalized = uncertainToolExecution(new Error("Invalid tool content after dispatch"));
            receipt.errorCategory = "invalid_content";
          }
        }
        if (tool!.outputSchema && normalized.result.success) {
          const payload = normalized.result.structuredContent ?? normalized.result.data;
          if (payload === null || typeof payload !== "object" || Array.isArray(payload) || validateParams(payload as Record<string, unknown>, tool!.outputSchema).length) {
            normalized = uncertainToolExecution(new Error("Tool output schema failed after dispatch; reconcile effects"));
            receipt.errorCategory = "invalid_output";
          }
        }
        receipt.phase = "settled";
        if (normalized.outcome === "unknown") receipt.reconciliation = "Independently reconcile the effect before retrying or completing work.";
        return finish(normalized);
      };
      const scheduler = renewal ? this.renewalScheduler : parent?.bound ?? this.scheduler;
      return await scheduler.run(mode, async bound => {
        try { return await dispatch(bound); }
        catch (error) {
          if (!handlerEntered) throw error;
          // Observe pipeline uncertainty before releasing the reservation, not
          // after the scheduler has already admitted the next queued effect.
          receipt.phase = "started";
          receipt.errorCategory = "execution_pipeline_failed";
          receipt.reconciliation = "Execution pipeline failed after entry; reconcile before retrying.";
          return finish(uncertainToolExecution(new Error("Execution pipeline failed after durable start")), false);
        }
      }, { signal: context.signal, deadline: context.deadline, clock: this.clock });
    } catch {
      if (handlerEntered) {
        receipt.phase = "started";
        receipt.errorCategory = "execution_pipeline_failed";
        receipt.reconciliation = "Execution entered its durable start boundary; reconcile before retrying.";
        return finish(uncertainToolExecution(new Error("Execution pipeline failed after durable start")), false);
      }
      // A failed start append never invokes the handler; leave the prior intent intact.
      receipt.startedAt = undefined;
      return reject(interruption() ?? "admission_pipeline_failed", "Tool was not dispatched: scheduling, policy, or journal admission failed");
    }
  }
}
