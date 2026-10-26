import { resizeImage } from "@earendil-works/pi-coding-agent";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { MediaStore } from "../media/media-store.js";
import type { ComfyToolContext } from "./types.js";

export const MAX_COMFY_RESULT_ATTACHMENTS = 2;
export const MAX_COMFY_RESULT_BYTES = 10 * 1024 * 1024;
export const MAX_COMFY_PREVIEW_BYTES = 512 * 1024;

/** Explicit result exposure only; never accepts a model-supplied host/destination path. */
export function createComfyResultAttachmentHandler(options: {
  readonly userId: string;
  readonly inbox: string;
  readonly media: MediaStore;
  readonly visualInput: boolean;
}): NonNullable<ComfyToolContext["attachResult"]> {
  const mounted = new Map<string, string>();
  let previews = 0;
  return async (artifact, preview) => {
    if (
      artifact.userId !== options.userId ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      artifact.bytes > MAX_COMFY_RESULT_BYTES
    )
      throw new Error("Comfy result is unavailable");
    // Verification covers the immutable bytes, not just the stored suffix/MIME.
    const object = options.media.verifiedObjectPath(artifact);
    let path = mounted.get(artifact.id);
    if (path === undefined) {
      if (mounted.size >= MAX_COMFY_RESULT_ATTACHMENTS)
        throw new Error("Comfy result attachment limit reached");
      if (realpathSync(options.inbox) !== options.inbox)
        throw new Error("Comfy result is unavailable");
      const directory = join(options.inbox, "results");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const metadata = lstatSync(directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 ||
        realpathSync(directory) !== directory
      )
        throw new Error("Comfy result is unavailable");
      const copied = options.media.materializeInbox(artifact, directory, 0);
      path = `/inbox/results/${basename(copied)}`;
      mounted.set(artifact.id, path);
    }
    const original = {
      path,
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
      sha256: artifact.sha256,
    };
    if (
      !preview ||
      !options.visualInput ||
      artifact.mediaKind !== "image" ||
      previews >= MAX_COMFY_RESULT_ATTACHMENTS
    )
      return original;
    previews += 1; // Reserve before yielding: concurrent calls cannot exceed the Turn budget.
    const resized = await resizeImage(readFileSync(object), artifact.mimeType, {
      maxWidth: 1024,
      maxHeight: 1024,
      maxBytes: MAX_COMFY_PREVIEW_BYTES,
      jpegQuality: 75,
    }).catch(() => null);
    if (
      !resized ||
      !["image/png", "image/jpeg"].includes(resized.mimeType) ||
      Buffer.byteLength(resized.data, "base64") > MAX_COMFY_PREVIEW_BYTES
    )
      return original;
    return {
      ...original,
      preview: {
        data: resized.data,
        mimeType: resized.mimeType as "image/png" | "image/jpeg",
      },
    };
  };
}
