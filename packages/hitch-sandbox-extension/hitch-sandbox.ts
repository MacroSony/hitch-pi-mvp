/**
 * Mandatory Phase 0 Hitch extension. Every standard Pi file/shell tool and
 * direct RPC/user bash path delegates to the same fail-closed backend.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	assertSandboxBackendReady,
	executeSandboxRequest,
} from "./sandbox-backend.mjs";
import { attestationBaseline, attestToolSet } from "./manifest-attest.mjs";

const webSearchEnabled = process.env.HITCH_WEB_SEARCH_ENABLED === "1";
const webSearchPath = process.env.HITCH_WEB_SEARCH_EXTENSION_PATH;
const webSearchDigest = process.env.HITCH_WEB_SEARCH_EXTENSION_SHA256;
if (webSearchEnabled !== (webSearchPath !== undefined && webSearchDigest !== undefined)) {
	throw new Error("Hitch web-search configuration is incomplete");
}
if (webSearchPath !== undefined && !webSearchPath.startsWith("/")) {
	throw new Error("Hitch web-search extension path is invalid");
}
if (webSearchDigest !== undefined && !/^[a-f0-9]{64}$/.test(webSearchDigest)) {
	throw new Error("Hitch web-search extension digest is invalid");
}
const expectedTools = attestationBaseline();
const selfPath = fileURLToPath(import.meta.url);
const requiredEnvironment = [
	"HITCH_P0_WORKSPACE",
	"HITCH_P0_INBOX",
	"HITCH_P0_PUBLISH_ROOT",
	"HITCH_P0_WORKER",
	"HITCH_P0_HELPER",
	"HITCH_P0_LOG",
	"HITCH_P0_TURN_HANDLE",
	"HITCH_P0_CONTROLLER_NONCE",
	"HITCH_P0_USER_ID",
	"HITCH_P0_UNIT_PREFIX",
	"HITCH_P0_WORKER_SHA256",
	"HITCH_P0_HELPER_SHA256",
	"HITCH_P0_EXTENSION_SHA256",
	"HITCH_P0_EXTENSION_PATH",
	"HITCH_P0_BACKEND_SHA256",
] as const;

for (const name of requiredEnvironment) {
	if (!process.env[name]) throw new Error("Hitch sandbox configuration is incomplete");
}
if (process.env.HITCH_P0_EXTENSION_PATH !== selfPath) {
	throw new Error("Hitch sandbox extension path is invalid");
}
if (!/^[a-f0-9]{32}$/.test(process.env.HITCH_P0_CONTROLLER_NONCE!)) {
	throw new Error("Hitch sandbox controller nonce is invalid");
}
if (!/^[a-f0-9]{16}$/.test(process.env.HITCH_P0_UNIT_PREFIX!)) {
	throw new Error("Hitch sandbox unit prefix is invalid");
}

function parseActiveTools(raw: string | undefined, baseline: readonly string[]): readonly string[] {
	if (raw === undefined) return baseline.slice().sort();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Hitch active tools configuration is invalid JSON");
	}
	if (!Array.isArray(parsed)) {
		throw new Error("Hitch active tools configuration is not an array");
	}
	const baselineSet = new Set(baseline);
	for (const tool of parsed) {
		if (typeof tool !== "string" || !baselineSet.has(tool)) {
			throw new Error("Hitch active tools contains unknown tool");
		}
	}
	const unique = [...new Set(parsed as string[])];
	if (unique.length !== parsed.length) {
		throw new Error("Hitch active tools contains duplicates");
	}
	const sorted = [...unique].sort();
	if (JSON.stringify(parsed) !== JSON.stringify(sorted)) {
		throw new Error("Hitch active tools is not strictly sorted");
	}
	return sorted;
}

const activeSubset = parseActiveTools(process.env.HITCH_ACTIVE_TOOLS, expectedTools);
const activeSubsetSet = new Set(activeSubset);

interface ForgePromptConfig {
	readonly mode: "replace" | "append" | "prepend";
	readonly systemPrompt: string;
}

function parseForgePrompt(raw: string | undefined): ForgePromptConfig | undefined {
	if (raw === undefined) return undefined;
	if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
		throw new Error("Hitch Forge prompt environment is too large");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Hitch Forge prompt is invalid JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Hitch Forge prompt is not an object");
	}
	const keys = Object.keys(parsed);
	if (keys.length !== 2 || !("mode" in parsed) || !("systemPrompt" in parsed)) {
		throw new Error("Hitch Forge prompt has invalid structure");
	}
	const record = parsed as Record<string, unknown>;
	const mode = record.mode;
	const systemPrompt = record.systemPrompt;
	if (mode !== "replace" && mode !== "append" && mode !== "prepend") {
		throw new Error("Hitch Forge prompt mode is invalid");
	}
	if (typeof systemPrompt !== "string") {
		throw new Error("Hitch Forge prompt systemPrompt is not a string");
	}
	if (Buffer.byteLength(systemPrompt, "utf8") > 32 * 1024) {
		throw new Error("Hitch Forge prompt exceeds 32KiB");
	}
	return { mode, systemPrompt };
}

const forgePrompt = parseForgePrompt(process.env.HITCH_FORGE_PROMPT);

function sha256(path: string): string {
	return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

const backendPath = fileURLToPath(new URL("./sandbox-backend.mjs", import.meta.url));
if (
	sha256(selfPath) !== process.env.HITCH_P0_EXTENSION_SHA256 ||
	sha256(backendPath) !== process.env.HITCH_P0_BACKEND_SHA256
) throw new Error("Hitch sandbox extension digest mismatch");
const mcpExtensionPath = process.env.HITCH_MCP_EXTENSION_PATH;
const mcpExtensionDigest = process.env.HITCH_MCP_EXTENSION_SHA256;
if ((mcpExtensionPath !== undefined) !== (mcpExtensionDigest !== undefined))
	throw new Error("Hitch MCP configuration is incomplete");
if (mcpExtensionPath !== undefined) {
	if (!mcpExtensionPath.startsWith("/"))
		throw new Error("Hitch MCP extension path is invalid");
	if (mcpExtensionDigest === undefined || !/^[a-f0-9]{64}$/.test(mcpExtensionDigest))
		throw new Error("Hitch MCP extension digest is invalid");
	if (sha256(mcpExtensionPath) !== mcpExtensionDigest)
		throw new Error("Hitch MCP extension digest mismatch");
}

const backendConfiguration = Object.freeze({
	workspace: process.env.HITCH_P0_WORKSPACE!,
	inbox: process.env.HITCH_P0_INBOX!,
	publishRoot: process.env.HITCH_P0_PUBLISH_ROOT!,
	worker: process.env.HITCH_P0_WORKER!,
	helper: process.env.HITCH_P0_HELPER!,
	log: process.env.HITCH_P0_LOG!,
	turnHandle: process.env.HITCH_P0_TURN_HANDLE!,
	unitPrefix: process.env.HITCH_P0_UNIT_PREFIX!,
	workerSha256: process.env.HITCH_P0_WORKER_SHA256!,
	helperSha256: process.env.HITCH_P0_HELPER_SHA256!,
	temporaryBytes: 4 * 1024 * 1024,
	memoryBytes: 256 * 1024 * 1024,
	maximumProcesses: 32,
	wallMilliseconds: 8_000,
});
assertSandboxBackendReady(backendConfiguration);

// Model-visible path guidance. Workspace paths are passed relative to the
// workspace root; only explicit read-only /inbox/... paths may appear for the
// read/search/list tools. The backend validators are unchanged.
const pathDescriptions = {
	read: "Workspace-relative file path (for example \"notes/todo.md\"), or an explicit read-only /inbox/... path. Never prefix it with /workspace/ or ./; .. traversal is rejected.",
	write: "Workspace-relative file path (for example \"notes/todo.md\"). Never prefix it with /workspace/ or ./; .. traversal is rejected.",
	edit: "Workspace-relative file path (for example \"notes/todo.md\"). Never prefix it with /workspace/ or ./; .. traversal is rejected.",
	ls: "Workspace-relative directory path (for example \"notes\"). Omit it or pass \".\" for the workspace root. An explicit read-only /inbox/... path lists inbound files. Never prefix it with /workspace/ or ./; .. traversal is rejected.",
	grep: "Workspace-relative directory whose file contents to search (for example \"src\"). Omit it or pass \".\" for the workspace root. An explicit read-only /inbox/... path searches inbound files. Never prefix it with /workspace/ or ./; .. traversal is rejected.",
	find: "Workspace-relative directory to search (for example \"src\"). Omit it or pass \".\" for the workspace root. An explicit read-only /inbox/... path searches inbound files. Never prefix it with /workspace/ or ./; .. traversal is rejected.",
	hitch_publish: "Workspace-relative file path, for example \"pelican-on-bike.svg\". Never prefix it with /workspace/ or ./; .. traversal is rejected. Success only snapshots the file; the service queues delivery after the Turn completes.",
} as const;

function pathType(description: string) {
	return Type.String({ minLength: 1, maxLength: 4096, description });
}

const schemas = {
	read: Type.Object({
		path: pathType(pathDescriptions.read),
		offset: Type.Optional(Type.Integer({ minimum: 1 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
	}, { additionalProperties: false }),
	write: Type.Object({
		path: pathType(pathDescriptions.write),
		content: Type.String({ maxLength: 2 * 1024 * 1024 }),
	}, { additionalProperties: false }),
	edit: Type.Object({
		path: pathType(pathDescriptions.edit),
		edits: Type.Array(Type.Object({
			oldText: Type.String({ minLength: 1, maxLength: 2 * 1024 * 1024 }),
			newText: Type.String({ maxLength: 2 * 1024 * 1024 }),
		}, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
	}, { additionalProperties: false }),
	ls: Type.Object({
		path: Type.Optional(pathType(pathDescriptions.ls)),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	}, { additionalProperties: false }),
	grep: Type.Object({
		pattern: Type.String({ minLength: 1, maxLength: 4096 }),
		path: Type.Optional(pathType(pathDescriptions.grep)),
		glob: Type.Optional(Type.String({ maxLength: 4096 })),
		ignoreCase: Type.Optional(Type.Boolean()),
		literal: Type.Optional(Type.Boolean()),
		context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	}, { additionalProperties: false }),
	find: Type.Object({
		pattern: Type.String({ minLength: 1, maxLength: 4096 }),
		path: Type.Optional(pathType(pathDescriptions.find)),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	}, { additionalProperties: false }),
	bash: Type.Object({
		command: Type.String({ minLength: 1, maxLength: 65536 }),
		timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
	}, { additionalProperties: false }),
	hitch_publish: Type.Object({ path: pathType(pathDescriptions.hitch_publish) }, { additionalProperties: false }),
} as const;

function stableDigest(value: unknown): string {
	function stable(item: unknown): unknown {
		if (Array.isArray(item)) return item.map(stable);
		if (item !== null && typeof item === "object") {
			return Object.fromEntries(Object.entries(item as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, stable(child)]));
		}
		return item;
	}
	return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function log(record: Record<string, unknown>): void {
	fs.appendFileSync(backendConfiguration.log, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function resultText(result: Record<string, unknown>): string {
	if (typeof result.text === "string") return result.text;
	if (typeof result.output === "string") return result.output;
	if (typeof result.artifactId === "string") {
		return `published artifact=${result.artifactId} bytes=${result.bytes} sha256=${result.sha256}`;
	}
	return JSON.stringify(result);
}

export default function (pi: ExtensionAPI): void {
	function attest(): { schemaDigest: string; allTools: readonly string[]; activeTools: readonly string[]; sourcePaths: readonly (string | undefined)[] } {
		// Dynamic-source tools (e.g. the MCP adapter) are excluded from
		// attestation by manifest-attest: they register and activate
		// asynchronously, and never route through the sandboxed execute() path.
		const attestation = attestToolSet(pi, {
			label: "sandbox",
			defaultPath: selfPath,
			pathOverrides:
				webSearchEnabled && webSearchPath !== undefined
					? { web_search: webSearchPath }
					: {},
			});
		const { all, active } = attestation;
		return {
			schemaDigest: stableDigest(all.map(({ name, parameters }) => ({ name, parameters }))),
			allTools: all.map((tool) => tool.name),
			activeTools: active,
			sourcePaths: attestation.sourcePaths,
		};
	}

	async function execute(name: keyof typeof schemas, input: Record<string, unknown>, signal?: AbortSignal) {
		// World attestation runs at session_start and before_agent_start; the
		// execute path is confined by bwrap regardless of the tool surface, so
		// per-execute re-verification only added fragility (async tool sources
		// legitimately change the world between turns).
		if (!activeSubsetSet.has(name)) {
			throw new Error(`Tool '${name}' is disabled`);
		}
		const requestInput = name === "bash"
			? { ...input, timeoutMs: Math.min(Number(input.timeout ?? 5) * 1000, 5000) }
			: name === "hitch_publish"
				? { ...input, artifactId: randomBytes(16).toString("hex") }
				: input;
		return executeSandboxRequest(backendConfiguration, { operation: name, input: requestInput }, signal);
	}

	const definitions = [
		["read", "Read a UTF-8 file. Pass a workspace-relative path such as \"notes/todo.md\"; never prefix it with /workspace/ or ./. An explicit /inbox/... path reads the read-only inbound mount; .. traversal is rejected."],
		["write", "Write a UTF-8 file to the workspace. Pass a workspace-relative path such as \"notes/todo.md\"; never prefix it with /workspace/ or ./ and never use .. traversal."],
		["edit", "Edit a workspace UTF-8 file using exact replacements. Pass a workspace-relative path such as \"notes/todo.md\"; never prefix it with /workspace/ or ./ and never use .. traversal."],
		["ls", "List a workspace directory. Pass a workspace-relative path such as \"notes\"; omit it or pass \".\" for the workspace root, and never prefix it with /workspace/ or ./. An explicit /inbox/... path lists the read-only inbound mount; .. traversal is rejected."],
		["grep", "Search workspace file contents. Pass a workspace-relative path; omit it or pass \".\" for the workspace root, and never prefix it with /workspace/ or ./. An explicit /inbox/... path searches the read-only inbound mount; .. traversal is rejected."],
		["find", "Find workspace paths. Pass a workspace-relative path; omit it or pass \".\" for the workspace root, and never prefix it with /workspace/ or ./. An explicit /inbox/... path searches the read-only inbound mount; .. traversal is rejected."],
		["bash", "Run a bounded shell command in the Hitch sandbox. Unlike the file tools, bash starts with cwd /workspace, where absolute paths such as /workspace/report.pdf are valid; /workspace prefixes belong in commands, not in file-tool path arguments."],
		["hitch_publish", "Publish one workspace file to the current IM conversation by snapshotting it. Use a workspace-relative path, for example hitch_publish({\"path\":\"pelican-on-bike.svg\"}); never prefix it with /workspace/ or ./ and never use .. traversal. Success only snapshots the file; the service queues delivery after the Turn completes, so do not tell the user delivery is already confirmed. Do not tell the user to open /workspace (they cannot)."],
	] as const;
	for (const [name, description] of definitions) {
		pi.registerTool({
			name,
			label: name,
			description,
			parameters: schemas[name],
			async execute(_id, input, signal) {
				try {
					const result = await execute(name, input as Record<string, unknown>, signal);
					return { content: [{ type: "text", text: resultText(result) }], details: {} };
				} catch {
					throw new Error("sandbox-failed");
				}
			},
		});
	}

	if (forgePrompt !== undefined) {
		pi.on("before_agent_start", async (event) => {
			attest();
			const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
			// Forge's compiler preserves the base for an empty rendered stack,
			// including model-only profiles. This is valid input, not load failure.
			if (forgePrompt.systemPrompt.trim().length === 0) return { systemPrompt: base };
			let systemPrompt: string;
			if (forgePrompt.mode === "replace") {
				systemPrompt = forgePrompt.systemPrompt;
			} else if (forgePrompt.mode === "prepend") {
				systemPrompt = base.length > 0 ? `${forgePrompt.systemPrompt}\n\n${base}` : forgePrompt.systemPrompt;
			} else {
				systemPrompt = base.length > 0 ? `${base}\n\n${forgePrompt.systemPrompt}` : forgePrompt.systemPrompt;
			}
			return { systemPrompt };
		});
	}

	pi.on("session_start", async () => {
		if (process.env.HITCH_SHARED_AUTH_REQUIRED === "1" && process.env.HITCH_SHARED_AUTH_INSTALLED !== "1") {
			throw new Error("shared-auth-failed");
		}
		if (process.env.HITCH_ANTIGRAVITY_ENABLED === "1" && process.env.HITCH_ANTIGRAVITY_INSTALLED !== "1") {
			throw new Error("antigravity-provider-failed");
		}
		pi.setActiveTools([...activeSubset]);
		const attestation = attest();
		const probe = await executeSandboxRequest(
			backendConfiguration,
			{ operation: "probe", input: {} },
		);
		if (
			probe.cwd !== "/workspace" || probe.hostHomeVisible !== false ||
			probe.networkNamespaceHasExternalInterface !== false || probe.networkDenied !== true ||
			probe.inboxWritable !== true || probe.publishVisible !== false ||
			JSON.stringify(probe.environmentKeys) !== JSON.stringify(["HOME", "PATH", "PWD", "TMPDIR"])
		) throw new Error("Hitch sandbox startup probe failed");
		if (process.env.HITCH_P0_FORCE_STARTUP_PROBE_FAILURE === "1") {
			throw new Error("Hitch sandbox injected startup probe failure");
		}
		log({
			type: "startup-attestation",
			sharedAuth: process.env.HITCH_SHARED_AUTH_INSTALLED === "1",
			antigravity: process.env.HITCH_ANTIGRAVITY_INSTALLED === "1",
			ready: true,
			controllerNonce: process.env.HITCH_P0_CONTROLLER_NONCE,
			userId: process.env.HITCH_P0_USER_ID,
			exactTools: expectedTools.slice().sort(),
			allTools: attestation.allTools,
			activeTools: attestation.activeTools,
			sourcePaths: attestation.sourcePaths,
			sourcePath: selfPath,
			extensionDigest: process.env.HITCH_P0_EXTENSION_SHA256,
			webSearchEnabled,
			schemaDigest: attestation.schemaDigest,
		});
	});

	pi.on("user_bash", async () => ({
		operations: {
			async exec(command, _cwd, options) {
				try {
					if (!activeSubsetSet.has("bash")) {
						throw new Error("bash is disabled");
					}
					const response = await executeSandboxRequest(
						backendConfiguration,
						{ operation: "bash", input: { command, timeoutMs: Math.min(options.timeout ?? 5000, 5000) } },
						options.signal,
					);
					const output = typeof response.output === "string" ? response.output : "";
					if (output) options.onData(Buffer.from(output));
					return { exitCode: typeof response.exitCode === "number" ? response.exitCode : 1 };
				} catch {
					options.onData(Buffer.from("sandbox-failed\n"));
					return { exitCode: 125 };
				}
			},
		},
	}));
}
