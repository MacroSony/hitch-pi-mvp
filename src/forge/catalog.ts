import {
  lstatSync,
  readdirSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  createForgeService,
  type ForgeServiceDocument,
  type ForgeServiceResolved,
} from "@zihanw/pi-forge/service";
import type {
  ForgeCatalog,
  ForgeResolved,
  ForgeResourceSummary,
} from "./types.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_CATALOG_FILES = 128;
const MAX_CATALOG_BYTES = 1024 * 1024;
const JSON_SUFFIX = ".json";

/**
 * Read the explicit operator-owned Forge root once and publish an immutable
 * catalog. This is deliberately not a loader: it never consults Forge's
 * workspace/global storage or any directory outside the supplied root.
 */
export function createForgeCatalog(options: {
  root: string;
  enabledUsers: readonly string[];
  forbiddenRoots?: readonly string[];
}): ForgeCatalog {
  if (
    !options ||
    typeof options.root !== "string" ||
    !isAbsolute(options.root)
  ) {
    throw forgeError("forge-invalid");
  }
  if (
    !Array.isArray(options.enabledUsers) ||
    options.enabledUsers.some((user) => typeof user !== "string")
  ) {
    throw forgeError("forge-invalid");
  }

  try {
    assertDirectory(options.root);
    if (realpathSync(options.root) !== resolve(options.root))
      throw forgeError("forge-unavailable");
    const root = resolve(options.root);
    for (const forbidden of options.forbiddenRoots ?? []) {
      const other = realpathSync(forbidden);
      if (
        root === other ||
        root.startsWith(other + sep) ||
        other.startsWith(root + sep)
      )
        throw forgeError("forge-unavailable");
    }
    const promptStacks = readDocuments(join(options.root, "prompt-stacks"));
    const agentProfiles = readDocuments(join(options.root, "agent-profiles"));
    if (
      promptStacks.count + agentProfiles.count > MAX_CATALOG_FILES ||
      promptStacks.bytes + agentProfiles.bytes > MAX_CATALOG_BYTES
    ) {
      throw forgeError("forge-invalid");
    }

    const service = createForgeService({
      promptStacks: promptStacks.documents,
      agentProfiles: agentProfiles.documents,
    });
    const enabledUsers = new Set(options.enabledUsers);
    const summaries = Object.freeze(
      (
        [
          ...service.list("preset"),
          ...service.list("profile"),
        ] satisfies readonly ForgeResourceSummary[]
      ).map((summary) => Object.freeze({ ...summary })),
    );

    const catalog: ForgeCatalog = {
      isEnabled(userId) {
        return enabledUsers.has(userId);
      },
      list(kind) {
        if (kind !== "preset" && kind !== "profile")
          throw forgeError("forge-invalid");
        return Object.freeze(
          summaries.filter((summary) => summary.kind === kind),
        );
      },
      resolve(selection, context) {
        if (
          !selection ||
          (selection.kind !== "preset" && selection.kind !== "profile") ||
          typeof selection.id !== "string"
        ) {
          throw forgeError("forge-invalid");
        }
        try {
          return freezeResolved(
            toForgeResolved(
              service.resolve(selection, {
                now: context?.now ?? new Date(),
                selectedTools: [...(context?.activeTools ?? [])],
                ...(context?.model === undefined
                  ? {}
                  : { model: context.model }),
              }),
            ),
          );
        } catch (error) {
          throw serviceError(error);
        }
      },
    };
    return Object.freeze(catalog);
  } catch (error) {
    throw serviceError(error);
  }
}

function readDocuments(directory: string): {
  documents: readonly ForgeServiceDocument[];
  count: number;
  bytes: number;
} {
  assertDirectory(directory);
  const documents: ForgeServiceDocument[] = [];
  let bytes = 0;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = lstatSync(path);
    if ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.())
      throw forgeError("forge-unavailable");
    if (stat.isSymbolicLink()) throw forgeError("forge-unavailable");
    if (!entry.endsWith(JSON_SUFFIX)) continue;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES)
      throw forgeError("forge-unavailable");

    if (documents.length >= MAX_CATALOG_FILES)
      throw forgeError("forge-invalid");
    // Descriptor-bounded read: a growing file cannot defeat the pre-read stat limit.
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let source: string;
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino
      )
        throw forgeError("forge-unavailable");
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size > MAX_FILE_BYTES || size !== stat.size)
        throw forgeError("forge-invalid");
      source = buffer.subarray(0, size).toString("utf8");
    } finally {
      closeSync(fd);
    }

    const after = lstatSync(path);
    if (
      !after.isFile() ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.nlink !== 1 ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    ) {
      throw forgeError("forge-unavailable");
    }
    bytes += stat.size;
    if (bytes > MAX_CATALOG_BYTES) throw forgeError("forge-invalid");
    const id = basename(entry, JSON_SUFFIX);
    documents.push({ id, source });
  }
  return {
    documents: Object.freeze(documents),
    count: documents.length,
    bytes,
  };
}

function assertDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    stat.uid !== process.getuid?.()
  ) {
    throw forgeError("forge-unavailable");
  }
}

function toForgeResolved(resolved: ForgeServiceResolved): ForgeResolved {
  return {
    selection: { kind: resolved.kind, id: resolved.id },
    name: resolved.name,
    mode: resolved.mode,
    systemPrompt: resolved.systemPrompt,
    ...(resolved.tools ? { tools: clonePolicy(resolved.tools) } : {}),
    ...(resolved.model ? { model: { ...resolved.model } } : {}),
    ...(resolved.thinkingLevel
      ? { thinkingLevel: resolved.thinkingLevel }
      : {}),
  };
}

function clonePolicy(
  policy: NonNullable<ForgeResolved["tools"]>,
): NonNullable<ForgeResolved["tools"]> {
  return {
    ...(policy.allow ? { allow: [...policy.allow] } : {}),
    ...(policy.deny ? { deny: [...policy.deny] } : {}),
  };
}

function freezeResolved(resolved: ForgeResolved): ForgeResolved {
  if (resolved.tools)
    (Object.freeze(resolved.tools.allow),
      Object.freeze(resolved.tools.deny),
      Object.freeze(resolved.tools));
  if (resolved.model) Object.freeze(resolved.model);
  Object.freeze(resolved.selection);
  return Object.freeze(resolved);
}

function serviceError(error: unknown): Error {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "forge-invalid" || code === "forge-unavailable")
      return forgeError(code);
  }
  return forgeError("forge-unavailable");
}

function forgeError(code: "forge-invalid" | "forge-unavailable"): Error {
  return Object.assign(new Error(code), { code });
}
