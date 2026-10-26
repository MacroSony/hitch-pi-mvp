import type { RuntimeArtifact } from "../runtime/runtime.js";
import type { RenderedComfyWorkflow } from "./workflow.js";

export type ComfyJobState =
  | "prepared"
  | "submitting"
  | "submitted"
  | "submission_unknown"
  | "completed"
  | "failed"
  | "cancelled";

/** Private host record. Never return snapshots, owner IDs or backend IDs to Pi. */
export interface ComfyJob {
  readonly id: string;
  readonly userId: string;
  readonly turnId: string;
  readonly workflowId: string;
  readonly snapshot: RenderedComfyWorkflow;
  readonly state: ComfyJobState;
  readonly backendPromptId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completionTurnId?: string;
}

export interface ComfyJobLedger {
  createComfyJob(
    userId: string,
    turnId: string,
    workflowId: string,
    snapshot: RenderedComfyWorkflow,
  ): ComfyJob;
  getComfyJob(userId: string, jobId: string): ComfyJob | null;
  listComfyJobs(userId: string, limit?: number): readonly ComfyJob[];
  pendingComfyJobs(limit?: number): readonly ComfyJob[];
  markComfyJobSubmitting(userId: string, jobId: string): boolean;
  markComfyJobSubmitted(
    userId: string,
    jobId: string,
    backendPromptId: string,
  ): boolean;
  markComfyJobUnknown(userId: string, jobId: string): boolean;
  markComfyJobRejected(userId: string, jobId: string): boolean;
  markComfyJobCancelled(userId: string, jobId: string): boolean;
  recoverComfyJobs(): void;
  finishComfyJob(
    userId: string,
    jobId: string,
    outcome: "completed" | "failed",
    artifact?: RuntimeArtifact,
  ): boolean;
}

export const COMFY_TOOL_NAMES = [
  "paint",
  "paint_job_cancel",
  "paint_job_status",
  "paint_list_workflows",
] as const;
export type ComfyToolName = (typeof COMFY_TOOL_NAMES)[number];
export interface ComfyToolContext {
  readonly userId: string;
  readonly turnId: string;
}
export interface ComfyToolHost {
  readonly enabledUsers: readonly string[];
  execute(
    context: ComfyToolContext,
    tool: ComfyToolName,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
