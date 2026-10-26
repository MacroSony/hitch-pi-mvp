import { randomBytes } from "node:crypto";
import type { RuntimeArtifact } from "../runtime/runtime.js";
import type { MediaStore } from "../media/media-store.js";
import { ComfyBackendError, type ComfyBackendClient } from "./client.js";
import { ComfyWorkflowPolicy } from "./workflow.js";
import type {
  ComfyJob,
  ComfyJobLedger,
  ComfyToolContext,
  ComfyToolHost,
  ComfyToolName,
} from "./types.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_MS = 2_000;
const SAFE = "Invalid Comfy tool request";

export interface ComfyServiceOptions {
  readonly ledger: ComfyJobLedger;
  readonly media: MediaStore;
  readonly backend: ComfyBackendClient;
  readonly workflows: readonly ComfyWorkflowPolicy[];
  readonly enabledUsers: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const p = Object.getPrototypeOf(value);
  return p === Object.prototype || p === null;
}
function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!record(value)) throw new Error(SAFE);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !(required.includes(key as string) || optional.includes(key as string)),
    )
  )
    throw new Error(SAFE);
  for (const key of required)
    if (!Object.hasOwn(value, key)) throw new Error(SAFE);
  return value;
}
function safeJob(job: ComfyJob): {
  id: string;
  workflow: string;
  state: string;
} {
  return { id: job.id, workflow: job.workflowId, state: job.state };
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

export class ComfyService implements ComfyToolHost {
  readonly enabledUsers: readonly string[];
  readonly #ledger: ComfyJobLedger;
  readonly #media: MediaStore;
  readonly #backend: ComfyBackendClient;
  readonly #workflows: readonly ComfyWorkflowPolicy[];
  #ticking: Promise<void> | null = null;

  constructor(options: ComfyServiceOptions) {
    this.#ledger = options.ledger;
    this.#media = options.media;
    this.#backend = options.backend;
    this.#workflows = Object.freeze([...options.workflows]);
    this.enabledUsers = Object.freeze([...new Set(options.enabledUsers)]);
  }

  async execute(
    context: ComfyToolContext,
    tool: ComfyToolName,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.enabledUsers.includes(context.userId)) throw new Error(SAFE);
    if (signal?.aborted) throw new Error(SAFE);
    switch (tool) {
      case "paint":
        return this.#paint(context, input, signal);
      case "paint_list_workflows":
        exact(input, []);
        return this.#workflowList();
      case "paint_job_status":
        return this.#status(context.userId, input);
      case "paint_job_cancel":
        return this.#cancel(context.userId, input, signal);
      default:
        throw new Error(SAFE);
    }
  }

  async #paint(
    context: ComfyToolContext,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const args = exact(
      input,
      ["prompt"],
      ["workflow", "negative_prompt", "width", "height"],
    );
    if (
      typeof args.prompt !== "string" ||
      args.prompt.length < 1 ||
      args.prompt.length > 8192 ||
      (args.workflow !== undefined &&
        (typeof args.workflow !== "string" ||
          !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(args.workflow))) ||
      (args.negative_prompt !== undefined &&
        (typeof args.negative_prompt !== "string" ||
          args.negative_prompt.length > 8192)) ||
      (args.width !== undefined &&
        (!Number.isSafeInteger(args.width) || (args.width as number) < 1)) ||
      (args.height !== undefined &&
        (!Number.isSafeInteger(args.height) || (args.height as number) < 1))
    )
      throw new Error(SAFE);
    const policy =
      args.workflow === undefined
        ? this.#workflows[0]
        : this.#workflows.find((w) => w.definition.id === args.workflow);
    if (!policy) throw new Error(SAFE);
    const vars = policy.definition.variables;
    const values: Record<string, unknown> = {};
    if (Object.hasOwn(vars, "prompt")) values.prompt = args.prompt;
    if (Object.hasOwn(vars, "negative") && args.negative_prompt !== undefined)
      values.negative = args.negative_prompt;
    if (Object.hasOwn(vars, "width") && args.width !== undefined)
      values.width = args.width;
    if (Object.hasOwn(vars, "height") && args.height !== undefined)
      values.height = args.height;
    if (Object.hasOwn(vars, "seed"))
      values.seed = randomBytes(6).readUIntBE(0, 6);
    const snapshot = policy.render(values);
    if (signal?.aborted) throw new Error(SAFE);
    const job = this.#ledger.createComfyJob(
      context.userId,
      context.turnId,
      policy.definition.id,
      snapshot,
    );
    this.#ledger.markComfyJobSubmitting(context.userId, job.id);
    try {
      const backendId = await this.#backend.submit(
        snapshot.graph,
        randomBytes(16).toString("hex"),
        signal,
      );
      this.#ledger.markComfyJobSubmitted(context.userId, job.id, backendId);
    } catch (error) {
      if (
        error instanceof ComfyBackendError &&
        error.code === "submission-rejected"
      )
        this.#ledger.markComfyJobRejected(context.userId, job.id);
      else this.#ledger.markComfyJobUnknown(context.userId, job.id);
    }
    return {
      id: job.id,
      workflow: policy.definition.id,
      state:
        this.#ledger.getComfyJob(context.userId, job.id)?.state ??
        "submission_unknown",
    };
  }

  #workflowList(): unknown {
    return this.#workflows.map((policy) => ({
      id: policy.definition.id,
      variables: Object.entries(policy.definition.variables).map(
        ([name, binding]) => {
          const base = { name, type: binding.type };
          return binding.type === "string"
            ? { ...base, maxLength: binding.maxLength }
            : binding.type === "integer"
              ? {
                  ...base,
                  min: binding.min,
                  max: binding.max,
                  ...(binding.step === undefined ? {} : { step: binding.step }),
                }
              : { ...base, values: [...binding.values] };
        },
      ),
    }));
  }

  #status(userId: string, input: unknown): unknown {
    const args = exact(input, [], ["job_id"]);
    if (
      args.job_id !== undefined &&
      (typeof args.job_id !== "string" || args.job_id.length > 128)
    )
      throw new Error(SAFE);
    const jobs =
      args.job_id === undefined
        ? this.#ledger.listComfyJobs(userId, 5)
        : [this.#ledger.getComfyJob(userId, args.job_id)].filter(
            (j): j is ComfyJob => j !== null,
          );
    return jobs.map(safeJob);
  }

  async #cancel(
    userId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const args = exact(input, ["job_id"]);
    if (typeof args.job_id !== "string" || args.job_id.length > 128)
      throw new Error(SAFE);
    const job = this.#ledger.getComfyJob(userId, args.job_id);
    if (!job) return { state: "unknown", cancel_result: "unknown" };
    if (job.state === "prepared") {
      const changed = this.#ledger.markComfyJobCancelled(userId, job.id);
      return {
        ...safeJob({ ...job, state: changed ? "cancelled" : job.state }),
        cancel_result: changed ? true : false,
      };
    }
    if (job.state !== "submitted" || !job.backendPromptId)
      return { ...safeJob(job), cancel_result: false };
    try {
      const result = await this.#backend.cancel(job.backendPromptId, signal);
      if (result === true) this.#ledger.markComfyJobCancelled(userId, job.id);
      return {
        ...safeJob({
          ...job,
          state: result === true ? "cancelled" : job.state,
        }),
        cancel_result: result,
      };
    } catch {
      return { ...safeJob(job), cancel_result: false };
    }
  }

  recover(): void {
    this.#ledger.recoverComfyJobs();
  }

  tick(signal?: AbortSignal): Promise<void> {
    if (this.#ticking) return this.#ticking;
    const task = this.#tick(signal).finally(() => {
      this.#ticking = null;
    });
    this.#ticking = task;
    return task;
  }

  async #tick(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    for (const job of this.#ledger.pendingComfyJobs(20)) {
      if (signal?.aborted) return;
      if (job.state !== "submitted" || !job.backendPromptId) continue;
      if (Date.now() - job.createdAt >= JOB_TIMEOUT_MS) {
        this.#ledger.finishComfyJob(job.userId, job.id, "failed");
        continue;
      }
      try {
        const history = await this.#backend.history(
          job.backendPromptId,
          job.snapshot.outputNodes,
          signal,
        );
        if (history.state === "pending") continue;
        if (history.state === "failed") {
          this.#ledger.finishComfyJob(job.userId, job.id, "failed");
          continue;
        }
        if (history.images.length !== 1) {
          this.#ledger.finishComfyJob(job.userId, job.id, "failed");
          continue;
        }
        const bytes = await this.#backend.download(history.images[0]!, signal);
        if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) {
          this.#ledger.finishComfyJob(job.userId, job.id, "failed");
          continue;
        }
        const artifact: RuntimeArtifact = await this.#media.ingest(
          job.userId,
          (async function* () {
            yield bytes;
          })(),
          {
            advertisedBytes: bytes.length,
            advertisedMime: "application/octet-stream",
            displayName: "comfy-result",
            expectImage: true,
          },
        );
        if (!artifact.mimeType.startsWith("image/")) {
          this.#ledger.finishComfyJob(job.userId, job.id, "failed");
          continue;
        }
        this.#ledger.finishComfyJob(job.userId, job.id, "completed", artifact);
      } catch (error) {
        if (signal?.aborted) return;
        if (
          error instanceof ComfyBackendError &&
          error.code === "history-unavailable"
        )
          continue;
        this.#ledger.finishComfyJob(job.userId, job.id, "failed");
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch {
        /* A failed poll is retried on the next bounded interval. */
      }
      await delay(POLL_MS, signal);
    }
  }
}
