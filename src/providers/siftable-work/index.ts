/** Siftable hosted MCP calls. Automatic durable recovery remains contract-gated. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from "../../framework/registry.js";
import type { ExecutionPolicy, ToolExecutionContext } from "../../framework/execution-types.js";
import type { InputSchema, ToolDefinition, ToolResult } from "../../framework/types.js";
import type { ContextProvider } from "../../framework/context.js";
import { createMcpProvider, type McpProviderOptions, type ConnectedMcpProvider } from "../mcp/index.js";

export const SIFTABLE_WORK_TOOL_ALLOWLIST = Object.freeze([
  "context_current", "work_item_get", "work_item_verification_plan_get",
  "work_item_verification_history",
]);
// Discovery is an availability fact, never a model-callable custody surface.
const WORK_DISCOVERY_ALLOWLIST = Object.freeze([
  ...SIFTABLE_WORK_TOOL_ALLOWLIST,
  "work_item_verification_evidence_submit", "work_session_open", "work_session_transition", "work_session_close",
]);

export const SIFTABLE_HOSTED_RECOVERY_STATUS = Object.freeze({
  enabled: false,
  inspectedVersion: "1.5.1",
  reasons: Object.freeze([
    "API deduplication key scope, receipt retention, payload-conflict behavior, and authoritative receipt lookup are not established by the published package.",
    "Evidence submission generates a fresh transport Idempotency-Key per invocation; attemptId uniqueness and safe resubmission are not established.",
    "Closed session replay compares action and key without verifying the changed payload.",
    "The published export map provides no supported work-contract parser; parseAgentWorkContract is vendored privately.",
  ]),
});

export interface SiftableActionReceipt {
  kind: "sift.action_receipt";
  schemaVersion: 1;
  receiptId: string;
  completedAt: string;
  surface: "mcp";
  binding: { status: "bound"; action: { id: string; version: number } } | { status: "unbound"; action: null };
  operation: { identifier: string; schemaDigest: string | null };
  outcome: "succeeded" | "rejected" | "failed";
  result: { contentType: "application/json"; schemaId: string; value: Record<string, unknown> }
    | { contentType: "text/plain"; value: string } | null;
  error: { code: string; message: string; recovery: string | null; details: Record<string, unknown> | null } | null;
  idempotency?: { key: string; payloadDigest: string; disposition: "created" | "replayed"; duplicateBehavior: "replay_same_payload_reject_changed_payload" };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate the published receipt shape; failed is never a not-started proof. */
export function parseSiftableActionReceipt(value: unknown, expectedTool?: string): SiftableActionReceipt | undefined {
  if (!object(value) || value.kind !== "sift.action_receipt" || value.schemaVersion !== 1 ||
      typeof value.receiptId !== "string" || !value.receiptId ||
      typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt)) ||
      value.surface !== "mcp" || !object(value.operation) ||
      typeof value.operation.identifier !== "string" ||
      !(value.operation.schemaDigest === null || typeof value.operation.schemaDigest === "string") ||
      (expectedTool !== undefined && value.operation.identifier !== expectedTool) ||
      !["succeeded", "rejected", "failed"].includes(String(value.outcome)) ||
      !object(value.binding) || !["bound", "unbound"].includes(String(value.binding.status))) return undefined;
  if (value.binding.status === "unbound" && value.binding.action !== null) return undefined;
  if (value.binding.status === "bound" && (!object(value.binding.action) || typeof value.binding.action.id !== "string" || !Number.isInteger(value.binding.action.version))) return undefined;
  if (value.outcome === "succeeded") {
    if (value.error !== null || !object(value.result)) return undefined;
    if (value.result.contentType === "application/json") {
      if (typeof value.result.schemaId !== "string" || !object(value.result.value)) return undefined;
    } else if (value.result.contentType !== "text/plain" || typeof value.result.value !== "string") return undefined;
  } else if (value.result !== null || !object(value.error) ||
      typeof value.error.code !== "string" || typeof value.error.message !== "string" ||
      !(value.error.recovery === null || typeof value.error.recovery === "string") ||
      !(value.error.details === null || object(value.error.details))) return undefined;
  if (value.idempotency !== undefined && (!object(value.idempotency) ||
      typeof value.idempotency.key !== "string" || typeof value.idempotency.payloadDigest !== "string" ||
      !["created", "replayed"].includes(String(value.idempotency.disposition)) ||
      value.idempotency.duplicateBehavior !== "replay_same_payload_reject_changed_payload")) return undefined;
  return value as unknown as SiftableActionReceipt;
}

export interface SiftableAuthenticatedContext {
  principalId: string;
  principalKind: "user" | "workspace_service" | "oauth_client";
  workspaceId: string | null;
  projectId: string | null;
  effectiveScopes: readonly string[];
}

export interface SiftableMcpProviderOptions extends Omit<McpProviderOptions, "id" | "isAuthoritativeRejection"> {
  id?: string;
  /** A trusted host selection to check against the authenticated server context. */
  expectedWorkspaceId?: string | null;
  projectId?: string;
  repositoryId?: string;
  /** Explicit trusted-host selection; default profiles cannot submit evidence. */
  evidenceExecution?: {
    policy: ExecutionPolicy;
    /** Resolve authority from host state, never from model arguments. */
    resolveContext: () => ToolExecutionContext | Promise<ToolExecutionContext>;
  };
}

export interface ConnectedSiftableMcpProvider extends ConnectedMcpProvider {
  readonly authenticatedContext: SiftableAuthenticatedContext;
  /** Trusted application code can bind this before the registry's policy runs. */
  readonly executionContext: Pick<ToolExecutionContext, "actor" | "scope">;
  /** Advertised by the authenticated remote catalog; never exposed by createTools(). */
  readonly hostedSessionsAvailable: boolean;
  readonly evidenceSubmissionAvailable: boolean;
}
export interface SiftableMcpProvider extends Omit<ContextProvider, "connect"> {
  connect(config?: Record<string, unknown>): Promise<ConnectedSiftableMcpProvider>;
}

function forbiddenTool(name: string): boolean {
  return name.startsWith("vault_") || name === "work_item_claim" || name === "work_item_transition" ||
    /^work_item_(?:start|heartbeat|block|review|complete|fail|cancel|release)$/.test(name);
}

function contextFrom(result: ToolResult, options: SiftableMcpProviderOptions): SiftableAuthenticatedContext {
  const receipt = parseSiftableActionReceipt(result.structuredContent, "context_current");
  const value = receipt?.result?.contentType === "application/json"
    ? receipt.result.value : result.structuredContent;
  if (!result.success || !object(value) || value.contractVersion !== 1 || !object(value.principal) ||
      value.principal.authority !== "validated_token" || typeof value.principal.id !== "string" || !value.principal.id ||
      !["user", "workspace_service", "oauth_client"].includes(String(value.principal.kind)) ||
      !object(value.queryContext) || !object(value.authorization) || !Array.isArray(value.authorization.effectiveScopes) ||
      !value.authorization.effectiveScopes.every((scope) => typeof scope === "string")) {
    throw new Error("Siftable hosted work requires context_current from a validated authenticated principal; connect with host-scoped credentials");
  }
  const workspaceId = value.queryContext.selectedWorkspaceContextId;
  if (!(workspaceId === null || typeof workspaceId === "string")) throw new Error("Siftable context did not establish its workspace scope");
  if (options.expectedWorkspaceId !== undefined && workspaceId !== options.expectedWorkspaceId) throw new Error("Siftable authenticated workspace does not match the host selection; reconnect with matching scope");
  let projectId: string | null = null;
  if (value.project !== null) {
    if (!object(value.project) || typeof value.project.id !== "string") throw new Error("Siftable context returned an invalid project reference");
    projectId = value.project.id;
  }
  if (options.projectId !== undefined && projectId !== options.projectId) throw new Error("Siftable project does not match the host's explicit selection");
  return Object.freeze({
    principalId: value.principal.id,
    principalKind: value.principal.kind as SiftableAuthenticatedContext["principalKind"],
    workspaceId, projectId,
    effectiveScopes: Object.freeze([...value.authorization.effectiveScopes] as string[]),
  });
}

/** Hosted calls use generic MCP; they do not load the optional embedded SDK. */
export function createSiftableMcpProvider(options: SiftableMcpProviderOptions): SiftableMcpProvider {
  if (options.transport?.kind === "stdio") throw new Error("Siftable hosted work requires authenticated StreamableHTTP; use the embedded provider for local ordinary domains");
  if (options.evidenceExecution && (typeof options.evidenceExecution.policy?.authorize !== "function" ||
      typeof options.evidenceExecution.resolveContext !== "function")) {
    throw new Error("Hosted evidence requires a trusted context resolver and execution policy");
  }
  const allowed = options.toolAllowlist ?? WORK_DISCOVERY_ALLOWLIST;
  for (const name of allowed) if (forbiddenTool(name)) throw new Error(`Siftable work profile refuses raw lifecycle or vault tools: ${name}`);
  const createGeneric = (captureCatalog?: (catalog: readonly { name: string }[]) => void) => createMcpProvider({
    ...options,
    id: options.id ?? "siftable-work",
    name: options.name ?? "Siftable hosted work",
    capabilities: options.capabilities ?? ["agent_work"],
    // Optional hosted capabilities are filtered by the actual authenticated catalog.
    toolAllowlist: options.toolAllowlist,
    approveCatalog: async (catalog) => {
      captureCatalog?.(catalog);
      const approved = options.approveCatalog ? await options.approveCatalog(catalog) : catalog.map((tool) => tool.name);
      return approved.filter((name) => allowed.includes(name) && !forbiddenTool(name));
    },
    isAuthoritativeRejection: (result: CallToolResult, name) => parseSiftableActionReceipt(result.structuredContent, name)?.outcome === "rejected",
  });
  return {
    metadata: createGeneric().metadata,
    async connect() {
      const advertisedNames = new Set<string>();
      const connected = await createGeneric((catalog) => {
        for (const tool of catalog) advertisedNames.add(tool.name);
      }).connect();
      try {
        const registry = new ToolRegistry();
        const contextTool = connected.createTools().find((tool) => tool.name === "context_current");
        if (!contextTool) throw new Error("Siftable hosted connection must advertise context_current before any work call");
        registry.register(contextTool);
        const result = await registry.execute("context_current", {
          ...(options.projectId ? { projectId: options.projectId } : {}),
          ...(options.repositoryId ? { repositoryId: options.repositoryId } : {}),
        });
        const authenticatedContext = contextFrom(result, options);
        const evidenceIdentity = authenticatedContext.principalKind === "user";
        const evidenceRegistry = options.evidenceExecution
          ? new ToolRegistry({ mode: "governed", policy: options.evidenceExecution.policy })
          : undefined;
        const executionContext = Object.freeze({
          actor: Object.freeze({ kind: authenticatedContext.principalKind === "workspace_service" ? "service" as const : "host" as const, id: authenticatedContext.principalId }),
          scope: Object.freeze({
            ...(authenticatedContext.workspaceId === null ? {} : { workspaceId: authenticatedContext.workspaceId }),
            ...(authenticatedContext.projectId === null ? {} : { projectId: authenticatedContext.projectId }),
          }),
        });
        return {
          ...connected,
          get catalog() { return connected.catalog; },
          get catalogStale() { return connected.catalogStale; },
          authenticatedContext, executionContext,
          get hostedSessionsAvailable() { return ["work_session_open", "work_session_transition", "work_session_close"].every((name) => advertisedNames.has(name)); },
          get evidenceSubmissionAvailable() { return !!evidenceRegistry && evidenceIdentity && connected.catalog.tools.some((tool) => tool.name === "work_item_verification_evidence_submit"); },
          async refreshCatalog() {
            throw new Error("Reconnect Siftable at a new session boundary to refresh both authenticated context and catalog");
          },
          createTools() {
            return connected.createTools().filter((tool) =>
              !tool.name.startsWith("work_session_") &&
              (tool.name !== "work_item_verification_evidence_submit" || (evidenceIdentity && evidenceRegistry !== undefined))
            ).map((upstreamTool): ToolDefinition => {
              const tool: ToolDefinition = {
                ...upstreamTool,
                handler: async (params, context) => {
                  if (Object.hasOwn(params, "workspaceId") && params.workspaceId !== authenticatedContext.workspaceId) {
                    return { success: false, executionOutcome: "failed", error: "Workspace arguments must match the host's authenticated selection; reconnect with the selected scope" };
                  }
                  if (options.projectId !== undefined && Object.hasOwn(params, "projectId") && params.projectId !== options.projectId) {
                    return { success: false, executionOutcome: "failed", error: "Project arguments must match the host's explicit selection" };
                  }
                  return upstreamTool.handler(params, context);
                },
              };
              if (tool.name !== "work_item_verification_evidence_submit") return tool;
              const inputSchema = structuredClone(tool.inputSchema) as InputSchema;
              delete inputSchema.properties.claimToken;
              delete inputSchema.properties.claimOwner;
              inputSchema.additionalProperties = false;
              const protectedEvidence: ToolDefinition = {
                ...tool, inputSchema,
                replayPolicy: "never",
                contract: {
                  version: "1",
                  useWhen: ["Submit external evidence under a validated trusted-host grant"],
                  doNotUseWhen: ["No trusted evidence policy or authenticated user binding"],
                  sideEffects: ["Creates a hosted verification evidence record"],
                  mutation: true, commitmentClass: "C2", idempotency: "non_idempotent",
                  requiresAuthority: true,
                },
                handler: async (params, context) => {
                  if (Object.hasOwn(params, "claimToken") || Object.hasOwn(params, "claimOwner")) {
                    return { success: false, executionOutcome: "failed", error: "Hosted evidence uses the authenticated user; raw lease custody is unavailable through this work profile" };
                  }
                  return tool.handler(params, context);
                },
              };
              if (!evidenceRegistry!.get(tool.name)) evidenceRegistry!.register(protectedEvidence);
              return {
                ...protectedEvidence,
                handler: async (params, context) => {
                  const host = await options.evidenceExecution!.resolveContext();
                  if (host.actor?.id !== authenticatedContext.principalId ||
                      (host.scope?.workspaceId ?? null) !== authenticatedContext.workspaceId ||
                      (host.scope?.projectId ?? null) !== authenticatedContext.projectId) {
                    return { success: false, executionOutcome: "failed", error: "Trusted evidence context must match the authenticated principal and selected scope" };
                  }
                  return evidenceRegistry!.execute(tool.name, params, {
                    ...host,
                    ...(context?.signal ? { signal: host.signal ? AbortSignal.any([host.signal, context.signal]) : context.signal } : {}),
                    ...(context?.correlationId ? { correlationId: context.correlationId } : {}),
                  });
                },
              };
            });
          },
        };
      } catch (error) {
        await connected.disconnect();
        throw error;
      }
    },
  };
}

/** Deliberately fail before claiming any work; the published recovery gate is incomplete. */
export function createSiftableWorkBackend(): never {
  throw new Error(`Siftable durable hosted backend is unavailable: ${SIFTABLE_HOSTED_RECOVERY_STATUS.reasons.join(" ")}`);
}
