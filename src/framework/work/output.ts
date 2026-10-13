/** Model projections are bounded independently of durable execution and evidence. */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { ArtifactQuotaError, DEFAULT_MODEL_OUTPUT_BYTES, type FileArtifactStore } from "../artifacts.js";
import type { ToolResult } from "../types.js";

const scalarKeys = ["id", "attemptId", "workItemId", "backendId", "planId", "planVersion", "stepId", "state", "backendState", "outcome", "executionId", "executionOutcome", "mutationEpoch", "actions", "outputBytes", "active", "exitCode", "readbackPassed", "specDigest", "digest", "environment", "startedAt", "finishedAt", "expiresAt", "sha256", "mediaType", "sizeBytes", "scopeDigest", "contractDigest", "revision", "planDigest"];
function summary(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 2 || !value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of scalarKeys) {
    const item = source[key];
    if (typeof item === "string") result[key] = item.slice(0, 512);
    else if (typeof item === "number" || typeof item === "boolean") result[key] = item;
  }
  for (const key of ["before", "after"]) {
    const subject = source[key] as { digest?: string; mutationEpoch?: number; inputManifest?: unknown[] } | undefined;
    if (subject) result[key] = { digest: subject.digest?.slice(0, 512), mutationEpoch: subject.mutationEpoch, inputCount: subject.inputManifest?.length };
  }
  for (const key of ["binding", "snapshot", "plan", "receipt", "lease", "artifact"]) {
    if (source[key]) result[key] = summary(source[key], depth + 1);
  }
  if (Array.isArray(source.evidence)) result.evidence = { count: source.evidence.length, items: source.evidence.slice(0, 8).map(item => summary(item, depth + 1)) };
  for (const key of ["unknownExecutions", "unresolvedOperations", "inflightStepIds", "outputArtifactRefs", "steps"]) {
    if (Array.isArray(source[key])) result[`${key}Count`] = source[key].length;
    else if (source[key] && typeof source[key] === "object") result[`${key}Count`] = Object.keys(source[key]).length;
  }
  return result;
}
function fits(result: ToolResult): boolean {
  return Buffer.byteLength(JSON.stringify(result)) <= DEFAULT_MODEL_OUTPUT_BYTES && Buffer.byteLength(JSON.stringify(result, null, 2)) <= DEFAULT_MODEL_OUTPUT_BYTES;
}
export function projectWorkOutput(result: ToolResult, artifactStore?: FileArtifactStore | (() => FileArtifactStore)): ToolResult {
  if (fits(result)) return result;
  const canonical = JSON.stringify(result);
  const digest = createHash("sha256").update(canonical).digest("hex");
  let projection: Record<string, unknown>;
  try {
    const store = typeof artifactStore === "function" ? artifactStore() : artifactStore;
    if (!store) throw new Error("Output artifact storage is unavailable");
    // Content identity makes repeated reads reuse a durable artifact, including after restart.
    const saved = readdirSync(store.rootDir).filter(name => name.endsWith(".artifact")).map(name => store.metadata(name.slice(0, -9))).find(ref => ref.sha256 === digest && ref.mediaType === "application/json");
    const artifact = saved ?? store.put(canonical, { mediaType: "application/json" });
    projection = { artifact, encoding: "utf-8", format: "canonical ToolResult JSON", readTool: "of_work_artifact_read" };
  } catch (error) {
    projection = { available: false, sha256: digest, sizeBytes: Buffer.byteLength(canonical), reason: error instanceof ArtifactQuotaError ? "Artifact quota exhausted" : "Output artifact storage is unavailable" };
  }
  const projected: ToolResult = {
    success: result.success,
    ...(result.executionOutcome ? { executionOutcome: result.executionOutcome } : {}),
    ...(result.error ? { error: result.error.slice(0, 512) } : {}),
    data: { ...summary(result.data), outputTruncated: true, artifactProjection: projection },
  };
  // Even unusual nesting/counts cannot escape the output budget.
  if (!fits(projected)) projected.data = { outputTruncated: true, artifactProjection: projection };
  return projected;
}
