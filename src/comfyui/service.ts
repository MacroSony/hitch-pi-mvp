import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RuntimeArtifact } from "../runtime/runtime.js";
import type { MediaStore } from "../media/media-store.js";
import {
  ComfyBackendError,
  comfyUploadPath,
  type ComfyBackendClient,
} from "./client.js";
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

function imageMime(bytes: Buffer): string {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return "application/octet-stream";
}

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
        !("value" in Object.getOwnPropertyDescriptor(value, key)!) ||
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
      case "paint_result":
        return this.#paintResult(context, input, signal);
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
      ["workflow", "negative_prompt", "width", "height", "input_files"],
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
    if (policy.definition.outputKind === "video")
      throw new Error("Comfy video execution is not yet enabled");
    const vars = policy.definition.variables;
    if (
      !Object.hasOwn(vars, "prompt") ||
      (args.negative_prompt !== undefined &&
        !Object.hasOwn(vars, "negative")) ||
      (args.width !== undefined && !Object.hasOwn(vars, "width")) ||
      (args.height !== undefined && !Object.hasOwn(vars, "height"))
    )
      throw new Error(SAFE);
    const values: Record<string, unknown> = { prompt: args.prompt };
    if (Object.hasOwn(vars, "negative") && args.negative_prompt !== undefined)
      values.negative = args.negative_prompt;
    if (Object.hasOwn(vars, "width") && args.width !== undefined)
      values.width = args.width;
    if (Object.hasOwn(vars, "height") && args.height !== undefined)
      values.height = args.height;
    if (Object.hasOwn(vars, "seed"))
      values.seed = randomBytes(6).readUIntBE(0, 6);
    const uploadedFiles: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    const refs =
      args.input_files === undefined ? [] : this.#inputFiles(args.input_files);
    const slots = policy.definition.files ?? {};
    if (Object.values(slots).some((binding) => binding.media !== "image"))
      throw new Error(SAFE);
    const seen = new Set<string>();
    const selected: { slot: string; artifact: RuntimeArtifact }[] = [];
    let totalBytes = 0;
    for (const ref of refs) {
      if (!Object.hasOwn(slots, ref.slot) || seen.has(ref.slot))
        throw new Error(SAFE);
      seen.add(ref.slot);
      const binding = slots[ref.slot]!;
      if (binding.media !== "image") throw new Error(SAFE);
      let artifact: RuntimeArtifact | undefined;
      if ("input_id" in ref) {
        artifact = context.inputs?.find(
          (entry) => entry.id === ref.input_id,
        )?.artifact;
      } else {
        artifact =
          this.#ledger.getComfyResult?.(context.userId, ref.job_id) ??
          undefined;
      }
      if (
        !artifact ||
        artifact.userId !== context.userId ||
        artifact.mediaKind !== "image" ||
        !["image/png", "image/jpeg", "image/webp"].includes(
          artifact.mimeType,
        ) ||
        artifact.bytes < 1 ||
        artifact.bytes > MAX_IMAGE_BYTES * 2 ||
        !Number.isSafeInteger(artifact.bytes)
      )
        throw new Error(SAFE);
      totalBytes += artifact.bytes;
      if (totalBytes > 40 * 1024 * 1024) throw new Error(SAFE);
      selected.push({ slot: ref.slot, artifact });
    }
    for (const slot of Object.keys(slots))
      if (!seen.has(slot) && !slots[slot]!.optional) throw new Error(SAFE);
    // Validate all ownership and metadata before reading any artifact bytes.
    const verified = selected.map(({ slot, artifact }) => {
      const path = this.#media.verifiedObjectPath(artifact);
      const bytes = readFileSync(path);
      if (
        bytes.length !== artifact.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
      )
        throw new Error(SAFE);
      const mime = imageMime(bytes);
      if (mime !== artifact.mimeType) throw new Error(SAFE);
      const planned = comfyUploadPath(
        context.userId,
        artifact.sha256,
        artifact.mimeType,
      );
      uploadedFiles[slot] = planned;
      return { slot, artifact, bytes, planned };
    });
    const snapshot = policy.render(values, uploadedFiles);
    if (signal?.aborted) throw new Error(SAFE);
    const job = this.#ledger.createComfyJob(
      context.userId,
      context.turnId,
      policy.definition.id,
      snapshot,
    );
    try {
      for (const item of verified) {
        if (signal?.aborted) throw new Error(SAFE);
        const returned = await this.#backend.upload(
          item.bytes,
          item.artifact.mimeType,
          context.userId,
          signal,
        );
        if (returned !== item.planned)
          throw new ComfyBackendError("upload-failed");
      }
    } catch {
      this.#ledger.markComfyJobRejected(context.userId, job.id);
      throw new Error(SAFE);
    }
    if (signal?.aborted) {
      this.#ledger.markComfyJobRejected(context.userId, job.id);
      throw new Error(SAFE);
    }
    if (!this.#ledger.markComfyJobSubmitting(context.userId, job.id)) {
      return {
        id: job.id,
        workflow: policy.definition.id,
        state:
          this.#ledger.getComfyJob(context.userId, job.id)?.state ?? "prepared",
      };
    }
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

  #inputFiles(
    value: unknown,
  ): ({ slot: string; input_id: string } | { slot: string; job_id: string })[] {
    if (
      !Array.isArray(value) ||
      value.length > 8 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw new Error(SAFE);
    return value.map((entry) => {
      const hasInput = record(entry) && Object.hasOwn(entry, "input_id");
      const fields = hasInput ? ["slot", "input_id"] : ["slot", "job_id"];
      const parsed = exact(entry, fields);
      const slot = parsed.slot;
      const id = hasInput ? parsed.input_id : parsed.job_id;
      if (
        typeof slot !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(slot) ||
        typeof id !== "string" ||
        id.length < 1 ||
        id.length > 128
      )
        throw new Error(SAFE);
      return hasInput ? { slot, input_id: id } : { slot, job_id: id };
    });
  }

  async #paintResult(
    context: ComfyToolContext,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const args = exact(input, ["job_id"], ["preview"]);
    if (
      typeof args.job_id !== "string" ||
      args.job_id.length < 1 ||
      args.job_id.length > 128 ||
      (args.preview !== undefined && typeof args.preview !== "boolean")
    )
      throw new Error(SAFE);
    const preview = args.preview !== false;
    const job = this.#ledger.getComfyJob(context.userId, args.job_id);
    if (!job)
      return {
        kind: "paint-result",
        job: { id: "unknown", workflow: "unknown", state: "unknown" },
      };
    const projection = { kind: "paint-result", job: safeJob(job) };
    if (job.state !== "completed") return projection;
    if (!this.#ledger.getComfyResult || !context.attachResult)
      throw new Error(SAFE);
    const artifact = this.#ledger.getComfyResult(context.userId, job.id);
    if (!artifact || artifact.userId !== context.userId) throw new Error(SAFE);
    if (signal?.aborted) throw new Error(SAFE);
    const attachment = await context.attachResult(artifact, preview);
    if (
      !/^\/inbox\/results\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(
        attachment.path,
      ) ||
      attachment.bytes !== artifact.bytes ||
      attachment.mimeType !== artifact.mimeType ||
      attachment.sha256 !== artifact.sha256
    )
      throw new Error(SAFE);
    if (attachment.preview !== undefined) {
      const p = attachment.preview;
      if (
        !preview ||
        (p.mimeType !== "image/png" && p.mimeType !== "image/jpeg") ||
        typeof p.data !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
          p.data,
        )
      )
        throw new Error(SAFE);
      const decoded = Buffer.from(p.data, "base64");
      if (decoded.length > 512 * 1024 || decoded.toString("base64") !== p.data)
        throw new Error(SAFE);
      const detected = imageMime(decoded);
      if (detected !== p.mimeType) throw new Error(SAFE);
    }
    return {
      ...projection,
      original: {
        path: attachment.path,
        bytes: attachment.bytes,
        mimeType: attachment.mimeType,
        sha256: attachment.sha256,
      },
      ...(attachment.preview === undefined
        ? {}
        : { preview: attachment.preview }),
    };
  }

  #workflowList(): unknown {
    return this.#workflows
      .filter(
        (policy) =>
          policy.definition.outputKind !== "video" &&
          Object.values(policy.definition.files ?? {}).every(
            (binding) => binding.media === "image",
          ),
      )
      .map((policy) => ({
        id: policy.definition.id,
        ...(Object.keys(policy.definition.files ?? {}).length === 0
          ? {}
          : {
              files: Object.entries(policy.definition.files!).map(
                ([slot, binding]) => ({
                  slot,
                  media: binding.media,
                  optional: binding.optional === true,
                }),
              ),
            }),
        variables: Object.entries(policy.definition.variables).map(
          ([name, binding]) => {
            const base = { name, type: binding.type };
            return binding.type === "string"
              ? { ...base, maxLength: binding.maxLength }
              : binding.type === "integer" || binding.type === "number"
                ? {
                    ...base,
                    min: binding.min,
                    max: binding.max,
                    ...(binding.step === undefined
                      ? {}
                      : { step: binding.step }),
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
      const actual = this.#ledger.getComfyJob(userId, job.id);
      return {
        ...safeJob(actual ?? job),
        cancel_result: changed && actual?.state === "cancelled",
      };
    }
    if (job.state !== "submitted" || !job.backendPromptId)
      return { ...safeJob(job), cancel_result: false };
    try {
      const result = await this.#backend.cancel(job.backendPromptId, signal);
      const changed =
        result === true && this.#ledger.markComfyJobCancelled(userId, job.id);
      const actual = this.#ledger.getComfyJob(userId, job.id);
      return {
        ...safeJob(actual ?? job),
        cancel_result: result === true && !changed ? false : result,
      };
    } catch {
      const actual = this.#ledger.getComfyJob(userId, job.id);
      return { ...safeJob(actual ?? job), cancel_result: "unknown" };
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
      if (!this.enabledUsers.includes(job.userId)) continue;
      if (job.state !== "submitted" || !job.backendPromptId) continue;
      if (Date.now() - job.createdAt >= JOB_TIMEOUT_MS) {
        this.#ledger.finishComfyJob(job.userId, job.id, "failed");
        continue;
      }
      let artifact: RuntimeArtifact | undefined;
      let finishing = false;
      try {
        const history = await this.#backend.history(
          job.backendPromptId,
          job.snapshot.outputNodes,
          signal,
        );
        if (history.state === "pending") continue;
        if (history.state === "failed" || history.images.length !== 1) {
          this.#ledger.finishComfyJob(job.userId, job.id, "failed");
          continue;
        }
        const bytes = await this.#backend.download(history.images[0]!, signal);
        if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) {
          this.#ledger.finishComfyJob(job.userId, job.id, "failed");
          continue;
        }
        const mime = imageMime(bytes);
        const extension =
          mime === "image/png"
            ? "png"
            : mime === "image/jpeg"
              ? "jpg"
              : mime === "image/webp"
                ? "webp"
                : "bin";
        artifact = await this.#media.ingest(
          job.userId,
          (async function* () {
            yield bytes;
          })(),
          {
            advertisedBytes: bytes.length,
            advertisedMime: "application/octet-stream",
            displayName: `paint-${job.id}.${extension}`,
            expectImage: true,
          },
        );
        if (
          artifact.mediaKind !== "image" ||
          !["image/png", "image/jpeg", "image/webp"].includes(
            artifact.mimeType,
          ) ||
          artifact.mimeType !== mime
        ) {
          this.#media.discard(artifact);
          artifact = undefined;
          this.#ledger.finishComfyJob(job.userId, job.id, "failed");
          continue;
        }
        finishing = true;
        const committed = this.#ledger.finishComfyJob(
          job.userId,
          job.id,
          "completed",
          artifact,
        );
        if (!committed) this.#media.discard(artifact);
        artifact = undefined;
      } catch (error) {
        if (artifact && !finishing) this.#media.discard(artifact);
        if (finishing) continue;
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
