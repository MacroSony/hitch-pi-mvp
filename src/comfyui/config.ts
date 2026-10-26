import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import {
  ComfyWorkflowPolicy,
  type ComfyWorkflowDefinition,
} from "./workflow.js";

const LIMIT = 1024 * 1024;
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))
  );
}

/** Operator-only, loaded once. No workspace/global-home discovery or model path input. */
export function loadComfyPolicies(
  path: string,
  forbiddenRoots: readonly string[] = [],
): readonly ComfyWorkflowPolicy[] {
  let fd: number | undefined;
  try {
    if (
      !isAbsolute(path) ||
      realpathSync(path) !== path ||
      forbiddenRoots.some((root) => within(root, path))
    )
      throw new Error();
    const parent = lstatSync(dirname(path));
    const before = lstatSync(path);
    const uid = process.getuid?.();
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o077) !== 0 ||
      (uid !== undefined && parent.uid !== uid)
    )
      throw new Error();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      (uid !== undefined && before.uid !== uid) ||
      before.size > LIMIT
    )
      throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mode !== before.mode
    )
      throw new Error();
    const bytes = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    const after = fstatSync(fd);
    if (
      length > LIMIT ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error();
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    );
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 4)
      throw new Error();
    const policies = parsed.map(
      (entry) => new ComfyWorkflowPolicy(entry as ComfyWorkflowDefinition),
    );
    if (
      new Set(policies.map((policy) => policy.definition.id)).size !==
      policies.length
    )
      throw new Error();
    return Object.freeze(policies);
  } catch {
    throw new Error("Comfy workflow configuration is invalid");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
