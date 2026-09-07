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

const EXPECTED_TOOLS = ["read", "write", "edit", "ls", "grep", "find", "bash", "hitch_publish"] as const;
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
const expectedTools = webSearchEnabled
	? [...EXPECTED_TOOLS, "web_search"]
	: [...EXPECTED_TOOLS];
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

const strictPath = Type.String({ minLength: 1, maxLength: 4096 });
const schemas = {
	read: Type.Object({
		path: strictPath,
		offset: Type.Optional(Type.Integer({ minimum: 1 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
	}, { additionalProperties: false }),
	write: Type.Object({
		path: strictPath,
		content: Type.String({ maxLength: 2 * 1024 * 1024 }),
	}, { additionalProperties: false }),
	edit: Type.Object({
		path: strictPath,
		edits: Type.Array(Type.Object({
			oldText: Type.String({ minLength: 1, maxLength: 2 * 1024 * 1024 }),
			newText: Type.String({ maxLength: 2 * 1024 * 1024 }),
		}, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
	}, { additionalProperties: false }),
	ls: Type.Object({
		path: Type.Optional(strictPath),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	}, { additionalProperties: false }),
	grep: Type.Object({
		pattern: Type.String({ minLength: 1, maxLength: 4096 }),
		path: Type.Optional(strictPath),
		glob: Type.Optional(Type.String({ maxLength: 4096 })),
		ignoreCase: Type.Optional(Type.Boolean()),
		literal: Type.Optional(Type.Boolean()),
		context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	}, { additionalProperties: false }),
	find: Type.Object({
		pattern: Type.String({ minLength: 1, maxLength: 4096 }),
		path: Type.Optional(strictPath),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	}, { additionalProperties: false }),
	bash: Type.Object({
		command: Type.String({ minLength: 1, maxLength: 65536 }),
		timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
	}, { additionalProperties: false }),
	hitch_publish: Type.Object({ path: strictPath }, { additionalProperties: false }),
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
		const all = pi.getAllTools().map((tool) => ({
			name: tool.name,
			path: tool.sourceInfo?.path,
			parameters: tool.parameters,
		})).sort((left, right) => left.name.localeCompare(right.name));
		const active = pi.getActiveTools().slice().sort();
		const expectedAll = expectedTools.slice().sort();
		const expectedActive = activeSubset.slice().sort();
		if (
			JSON.stringify(all.map((tool) => tool.name)) !== JSON.stringify(expectedAll) ||
			JSON.stringify(active) !== JSON.stringify(expectedActive) ||
			all.some((tool) => tool.name === "web_search"
				? tool.path !== webSearchPath
				: tool.path !== selfPath)
		) throw new Error("Hitch sandbox tool attestation failed");
		return {
			schemaDigest: stableDigest(all.map(({ name, parameters }) => ({ name, parameters }))),
			allTools: all.map((tool) => tool.name),
			activeTools: active,
			sourcePaths: all.map((tool) => tool.path),
		};
	}

	async function execute(name: keyof typeof schemas, input: Record<string, unknown>, signal?: AbortSignal) {
		attest();
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
		["read", "Read a UTF-8 file beneath /workspace or the read-only /inbox."],
		["write", "Write a UTF-8 file beneath /workspace."],
		["edit", "Edit a UTF-8 file beneath /workspace using exact replacements."],
		["ls", "List a directory beneath /workspace or /inbox."],
		["grep", "Search file contents beneath /workspace or /inbox."],
		["find", "Find paths beneath /workspace or /inbox."],
		["bash", "Run a bounded shell command in the Hitch sandbox."],
		["hitch_publish", "Snapshot one workspace file into the Turn publication bridge."],
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
					attest();
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
