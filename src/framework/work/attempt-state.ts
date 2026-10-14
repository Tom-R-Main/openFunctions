/** Internal durable attempt shapes. Extraction must not change stored JSON fields. */
import type { BackendReceipt, LeaseRef, OperationKind, OperationRef, VerificationEvidence, WorkAuthorizationBinding, WorkPreview, WorkState } from "./types.js";
import type { ToolExecutionContext } from "../execution-types.js";
import type { WorkJournalEventType } from "./journal.js";
export interface PendingOperation {
  ref: OperationRef;
  payload: Record<string, unknown>;
  status: "started" | "settled";
  backendReceipt?: BackendReceipt;
}
export interface StepIntent {
  stepKey: string;
  inputDigest: string;
  capabilityDigest: string;
  admittedPaths: string[];
  reconciliationMetadata?: Readonly<Record<string, unknown>>;
  oracleDigest?: string;
}
export interface PersistedAttempt {
  attemptId: string;
  workItemId: string;
  executionFileIdentity?: {
    dev: string;
    ino: string;
  };
  binding: WorkAuthorizationBinding;
  preview: WorkPreview;
  state: WorkState;
  startedAt: number;
  mutationEpoch: number;
  actions: number;
  outputBytes: number;
  accountedOutputs: Record<string, {
    bytes: number;
    recorded: boolean;
  }>;
  lease?: LeaseRef;
  operations: Record<string, PendingOperation>;
  inflightSteps: Record<string, StepIntent>;
  unknownSteps: Record<string, StepIntent>;
  oracleRuns: Record<string, {
    originalExecutionId: string;
    oracleDigest: string;
    inputDigest: string;
  }>;
  effectResolutions: Record<string, {
    effect: "verified";
    readbackExecutionId: string;
    sourceRefs: string[];
  }>;
  evidence: Record<string, VerificationEvidence>;
  verificationRuns: Record<string, {
    stepId: string;
    evidenceId: string;
  }>;
  outputArtifacts: Record<string, string>;
  unknownExecutions: string[];
  renewalFailed: boolean;
}
/** Persistence is owned by the controller; collaborators request ordered events. */
export type AttemptPersistence = (type: WorkJournalEventType, data?: Record<string, unknown>, refs?: {
  executionId?: string;
  receiptRef?: string;
}) => void;
export type BackendOperation = (kind: OperationKind, payload: Record<string, unknown>, dispatch: (ref: OperationRef) => Promise<BackendReceipt>, id?: string, backendKey?: string, context?: ToolExecutionContext) => Promise<BackendReceipt>;
