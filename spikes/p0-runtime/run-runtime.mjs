#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const fixtureExtension = join(here, "provider-fixture.ts");
const oauthWorker = join(here, "oauth-worker.mjs");
const authCrashWorker = join(here, "auth-crash-worker.mjs");
const evidencePath = join(here, "P0-RUNTIME-EVIDENCE.json");
const temporary = mkdtempSync(join(tmpdir(), "hitch-p0-runtime-"));
const workspace = join(temporary, "workspace");
let piPackageRootForWorkers;

const PI_VERSION = "0.84.1";
const PI_TREE_SHA256 = "7298ead16e553a8ffc372ca6a5a17ccfd711ae0887830134255dcea08be55bba";
const PI_DEPENDENCY_CLOSURE_SHA256 = "6d2055eaeef6823fd4b6edc062314e383fc6e233a4634a13e868a86eaebbcec4";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const EXPECTED_MODEL_CAPABILITIES = [
	{ key: "hitch-fixture-key/plain-text", reasoning: false, input: ["text"] },
	{ key: "hitch-fixture-key/reasoning-image", reasoning: true, input: ["image", "text"] },
	{ key: "hitch-fixture-oauth/oauth-reasoning", reasoning: true, input: ["text"] },
];
const EXPECTED_MODELS = EXPECTED_MODEL_CAPABILITIES.map((model) => model.key);
const STANDARD_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high"];
const SYNTHETIC_VALUES = [
	"HITCH_SYNTHETIC_API_KEY",
	"HITCH_SYNTHETIC_OAUTH_ACCESS",
	"HITCH_SYNTHETIC_OAUTH_ACCESS_REFRESHED",
	"fixture-refresh-0",
	"fixture-refresh-0-rotated",
];

function fail(message) {
	throw new Error(message);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
	return createHash("sha256").update(value).digest("hex");
}

function treeSha256(root, includeDependencies = false) {
	const hash = createHash("sha256");
	function visit(directory, prefix = "") {
		for (const name of readdirSync(directory).sort()) {
			if (!includeDependencies && !prefix && name === "node_modules") continue;
			const absolute = join(directory, name);
			const relative = prefix ? `${prefix}/${name}` : name;
			const stat = lstatSync(absolute);
			if (stat.isDirectory()) {
				hash.update(`d\0${relative}\0`);
				visit(absolute, relative);
			} else if (stat.isSymbolicLink()) {
				hash.update(`l\0${relative}\0${readlinkSync(absolute)}\0`);
			} else if (stat.isFile()) {
				hash.update(`f\0${relative}\0`);
				hash.update(readFileSync(absolute));
				hash.update("\0");
			}
		}
	}
	visit(root);
	return hash.digest("hex");
}

function commandOutput(command, args = []) {
	const result = spawnSync(command, args, {
		cwd: repository,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: temporary, LANG: "C.UTF-8", NO_COLOR: "1" },
		timeout: 15_000,
	});
	if (result.status !== 0) fail(`${command} failed: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function profileAuth(expires) {
	return {
		"hitch-fixture-oauth": {
			type: "oauth",
			access: "HITCH_SYNTHETIC_OAUTH_ACCESS",
			refresh: "fixture-refresh-0",
			expires,
		},
	};
}

function minimalEnvironment(profile, overrides = {}) {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: temporary,
		LANG: "C.UTF-8",
		NO_COLOR: "1",
		PI_CODING_AGENT_DIR: profile,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		...overrides,
	};
}

function baseArgs(profile, session) {
	const args = [
		"--mode", "rpc",
		"--offline",
		"--no-extensions",
		"--extension", fixtureExtension,
		"--no-builtin-tools",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-approve",
	];
	if (session) {
		if (session.path) args.push("--session", session.path);
		else args.push("--session-id", session.id);
		args.push("--session-dir", session.directory);
	} else {
		args.push("--no-session");
	}
	return args;
}

function assertNoSyntheticValue(output, label) {
	for (const value of SYNTHETIC_VALUES) {
		if (output.includes(value)) fail(`${label}: RPC/stderr exposed synthetic credential material`);
	}
}

function runPi(name, { profile, session, commands, env = {} }) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("pi", baseArgs(profile, session), {
			cwd: workspace,
			env: minimalEnvironment(profile, env),
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let lineBuffer = "";
		let commandIndex = 0;
		let commandResponseSeen = false;
		let commandTerminalSeen = false;
		const parsedEvents = [];
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		const sendNext = () => {
			if (commandIndex >= commands.length) {
				child.stdin.end();
				return;
			}
			const outgoing = { ...commands[commandIndex] };
			delete outgoing._waitForTerminal;
			child.stdin.write(`${JSON.stringify(outgoing)}\n`);
		};
		const advanceWhenReady = () => {
			const current = commands[commandIndex];
			if (!commandResponseSeen || (current?._waitForTerminal && !commandTerminalSeen)) return;
			commandIndex++;
			commandResponseSeen = false;
			commandTerminalSeen = false;
			sendNext();
		};
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			lineBuffer += chunk;
			while (lineBuffer.includes("\n")) {
				const newline = lineBuffer.indexOf("\n");
				const line = lineBuffer.slice(0, newline);
				lineBuffer = lineBuffer.slice(newline + 1);
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					parsedEvents.push(event);
					if (event?.type === "response" && event?.id === commands[commandIndex]?.id) {
						commandResponseSeen = true;
						advanceWhenReady();
					} else if (commands[commandIndex]?._waitForTerminal && event?.type === "agent_settled") {
						commandTerminalSeen = true;
						advanceWhenReady();
					}
				} catch {
					// The close handler reports the complete non-JSON output.
				}
			}
		});
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", rejectPromise);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			try {
				if (code !== 0) fail(`${name}: Pi exited code=${code} signal=${signal}; stderr=${stderr.trim().slice(0, 1200)}; stdout-tail=${stdout.slice(-2000)}`);
				assertNoSyntheticValue(stdout, `${name} stdout`);
				assertNoSyntheticValue(stderr, `${name} stderr`);
				if (lineBuffer.trim()) fail(`${name}: incomplete RPC stdout: ${lineBuffer.slice(0, 200)}`);
				const exactLines = stdout.split("\n").filter((line) => line.trim());
				if (parsedEvents.length !== exactLines.length) fail(`${name}: non-JSON RPC stdout detected`);
				resolvePromise({ events: parsedEvents, stderr });
			} catch (error) {
				rejectPromise(error);
			}
		});
		sendNext();
	});
}

function response(events, id, success = true) {
	const found = events.find((event) => event?.type === "response" && event?.id === id);
	if (!found) fail(`missing RPC response ${id}`);
	if (found.success !== success) fail(`${id}: expected success=${success}, got ${found.success}`);
	return found;
}

function exactSet(actual, expected, label) {
	const left = [...actual].sort();
	const right = [...expected].sort();
	if (JSON.stringify(left) !== JSON.stringify(right)) {
		fail(`${label}: expected ${JSON.stringify(right)}, got ${JSON.stringify(left)}`);
	}
}

function sanitizedModels(events, id = "catalog") {
	const models = response(events, id).data?.models;
	if (!Array.isArray(models)) fail(`${id}: missing model list`);
	return models.map((model) => ({
		key: `${model.provider}/${model.id}`,
		reasoning: model.reasoning === true,
		input: [...(model.input ?? [])].sort(),
	})).sort((left, right) => left.key.localeCompare(right.key));
}

function assertCatalog(events, expectedKeys, label) {
	const models = sanitizedModels(events);
	if (JSON.stringify(models) !== JSON.stringify(EXPECTED_MODEL_CAPABILITIES)) {
		fail(`${label}: exact capability tuples differed: ${JSON.stringify(models)}`);
	}
	exactSet(models.map((model) => model.key), expectedKeys, `${label} model keys`);
	return { models, digest: sha256Text(JSON.stringify(models)) };
}

function state(events, id) {
	return response(events, id).data;
}

function findFiles(root, suffix) {
	const found = [];
	function visit(directory) {
		for (const name of readdirSync(directory)) {
			const path = join(directory, name);
			const stat = lstatSync(path);
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile() && name.endsWith(suffix)) found.push(path);
		}
	}
	visit(root);
	return found;
}

function durableSync(path) {
	const fileDescriptor = openSync(path, "r");
	try {
		fsyncSync(fileDescriptor);
	} finally {
		closeSync(fileDescriptor);
	}
	const directoryDescriptor = openSync(dirname(path), "r");
	try {
		fsyncSync(directoryDescriptor);
	} finally {
		closeSync(directoryDescriptor);
	}
	return { fileFsync: true, parentDirectoryFsync: true };
}

function countEvents(events, type) {
	return events.filter((event) => event?.type === type).length;
}

function assertAgentSettled(events, dependentResponseId, expectedTurnEnds, label) {
	const settledIndexes = events.flatMap((event, index) => event?.type === "agent_settled" ? [index] : []);
	if (settledIndexes.length !== 1) fail(`${label}: expected one agent_settled event`);
	if (countEvents(events, "turn_end") !== expectedTurnEnds) {
		fail(`${label}: expected ${expectedTurnEnds} turn_end events`);
	}
	const dependentIndex = events.findIndex((event) => event?.type === "response" && event?.id === dependentResponseId);
	if (dependentIndex < settledIndexes[0]) fail(`${label}: dependent RPC ran before agent_settled`);
	return {
		turnEnds: expectedTurnEnds,
		agentEnds: countEvents(events, "agent_end"),
		agentSettled: 1,
		dependentRpcAfterSettled: true,
	};
}

function readJsonLines(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function modelAndSessionCase() {
	const profile = join(temporary, "model-profile");
	const sessionDirectory = join(temporary, "sessions");
	const streamLog = join(temporary, "model-stream.jsonl");
	writeJson(join(profile, "auth.json"), profileAuth(Date.now() + 60 * 60 * 1000));
	writeJson(join(profile, "models-store.json"), {});
	const session = { id: SESSION_ID, directory: sessionDirectory };

	const first = await runPi("model-session-first", {
		profile,
		session,
		commands: [
			{ id: "catalog", type: "get_available_models" },
			{ id: "select", type: "set_model", provider: "hitch-fixture-key", modelId: "reasoning-image" },
			{ id: "levels", type: "get_available_thinking_levels" },
			{ id: "thinking", type: "set_thinking_level", level: "high" },
			{ id: "selected", type: "get_state" },
			{ id: "unknown", type: "set_model", provider: "hitch-fixture-key", modelId: "missing" },
			{ id: "turn", type: "prompt", message: "HITCH_FIXTURE_CONTEXT", _waitForTerminal: true },
			{ id: "last", type: "get_last_assistant_text" },
		],
		env: {
			HITCH_FIXTURE_STREAM_LOG: streamLog,
			HITCH_FIXTURE_TOOL_LOOP: "1",
		},
	});
	const catalog = assertCatalog(first.events, EXPECTED_MODELS, "model-session-first");
	const reasoner = catalog.models.find((model) => model.key.endsWith("/reasoning-image"));
	if (!reasoner?.reasoning || JSON.stringify(reasoner.input) !== JSON.stringify(["image", "text"])) {
		fail("reasoning-image capabilities were not preserved");
	}
	exactSet(response(first.events, "levels").data.levels, STANDARD_REASONING_LEVELS, "reasoning levels");
	const selected = state(first.events, "selected");
	if (selected.model?.provider !== "hitch-fixture-key" || selected.model?.id !== "reasoning-image" || selected.thinkingLevel !== "high") {
		fail("selected model/thinking state did not match");
	}
	response(first.events, "unknown", false);
	response(first.events, "turn");
	if (response(first.events, "last").data?.text !== "HITCH_FIXTURE_ASSISTANT") fail("synthetic provider response mismatch");
	const settled = assertAgentSettled(first.events, "last", 2, "model tool loop");
	const streamCalls = readJsonLines(streamLog);
	if (
		streamCalls.length !== 2 ||
		streamCalls[0]?.model !== "hitch-fixture-key/reasoning-image" ||
		streamCalls[0]?.hasFixtureToolResult !== false ||
		streamCalls[1]?.model !== "hitch-fixture-key/reasoning-image" ||
		streamCalls[1]?.hasFixtureToolResult !== true
	) {
		fail(`model tool loop did not make the expected two provider calls: ${JSON.stringify(streamCalls)}`);
	}
	if (!existsSync(selected.sessionFile)) {
		const actualFiles = existsSync(sessionDirectory) ? findFiles(sessionDirectory, ".jsonl") : [];
		fail(`reported session file was not persisted; actual=${JSON.stringify(actualFiles)}`);
	}
	const beforeRestartEntries = readFileSync(selected.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	if (!beforeRestartEntries.some((entry) => entry.type === "message")) {
		fail(`context fixture was not persisted: ${JSON.stringify(beforeRestartEntries.map((entry) => entry.type))}`);
	}
	const firstDurableSync = durableSync(selected.sessionFile);
	// Prove restoration comes from the transcript, not Pi's mutable global
	// default-model settings written by set_model/set_thinking_level.
	rmSync(join(profile, "settings.json"), { force: true });

	const second = await runPi("model-session-second", {
		profile,
		session: { path: selected.sessionFile, directory: sessionDirectory },
		commands: [
			{ id: "catalog", type: "get_available_models" },
			{ id: "restored", type: "get_state" },
			{ id: "levels", type: "get_available_thinking_levels" },
			{ id: "plain", type: "set_model", provider: "hitch-fixture-key", modelId: "plain-text" },
			{ id: "clamp", type: "set_thinking_level", level: "high" },
			{ id: "final", type: "get_state" },
		],
	});
	const secondCatalog = assertCatalog(second.events, EXPECTED_MODELS, "model-session-second");
	if (secondCatalog.digest !== catalog.digest) fail("model catalog digest changed across controllers");
	const restored = state(second.events, "restored");
	if (restored.model?.provider !== "hitch-fixture-key" || restored.model?.id !== "reasoning-image" || restored.thinkingLevel !== "high") {
		fail(`fresh controller did not restore model/thinking state: ${restored.model?.provider}/${restored.model?.id}:${restored.thinkingLevel}`);
	}
	exactSet(response(second.events, "levels").data.levels, STANDARD_REASONING_LEVELS, "restored reasoning levels");
	const final = state(second.events, "final");
	if (final.model?.provider !== "hitch-fixture-key" || final.model?.id !== "plain-text" || final.thinkingLevel !== "off") {
		fail("non-reasoning model did not clamp thinking to off");
	}
	if (restored.sessionFile !== selected.sessionFile || restored.sessionId !== SESSION_ID) {
		fail(`fresh controller did not bind the same stable session: first=${selected.sessionFile}/${selected.sessionId} second=${restored.sessionFile}/${restored.sessionId}`);
	}
	const secondDurableSync = durableSync(selected.sessionFile);

	const sessionFiles = findFiles(sessionDirectory, ".jsonl");
	if (sessionFiles.length !== 1) fail(`expected one session file, got ${sessionFiles.length}`);
	const entries = readFileSync(sessionFiles[0], "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const types = entries.map((entry) => entry.type);
	const expectedTypes = [
		"session",
		"model_change",
		"thinking_level_change",
		"model_change",
		"thinking_level_change",
		"thinking_level_change",
		"message",
		"message",
		"message",
		"message",
		"model_change",
		"thinking_level_change",
	];
	if (JSON.stringify(types) !== JSON.stringify(expectedTypes)) {
		fail(`unexpected session entry sequence ${JSON.stringify(types)}`);
	}
	return {
		pass: true,
		exactModels: EXPECTED_MODELS,
		exactModelCapabilities: catalog.models,
		catalogSha256: catalog.digest,
		reasoningLevels: STANDARD_REASONING_LEVELS,
		unknownModelRejected: true,
		restoredAcrossFreshController: true,
		restoredModel: "hitch-fixture-key/reasoning-image",
		restoredThinking: "high",
		nonReasoningClamp: "off",
		sessionId: SESSION_ID,
		sessionFile: basename(sessionFiles[0]),
		sessionEntryTypes: types,
		providerStreamCalls: streamCalls.length,
		toolLoopSettlement: settled,
		durableSync: { first: firstDurableSync, second: secondDurableSync },
	};
}

async function preFlushCase() {
	const profile = join(temporary, "preflush-profile");
	const sessionDirectory = join(temporary, "preflush-sessions");
	writeJson(join(profile, "auth.json"), profileAuth(Date.now() + 60 * 60 * 1000));
	writeJson(join(profile, "models-store.json"), {});
	const result = await runPi("preflush", {
		profile,
		session: { id: "33333333-3333-4333-8333-333333333333", directory: sessionDirectory },
		commands: [
			{ id: "select", type: "set_model", provider: "hitch-fixture-key", modelId: "reasoning-image" },
			{ id: "thinking", type: "set_thinking_level", level: "high" },
			{ id: "state", type: "get_state" },
		],
	});
	const selected = state(result.events, "state");
	if (selected.model?.provider !== "hitch-fixture-key" || selected.model?.id !== "reasoning-image" || selected.thinkingLevel !== "high") {
		fail("preflush state was not retained in process");
	}
	const sessionFiles = existsSync(sessionDirectory) ? findFiles(sessionDirectory, ".jsonl") : [];
	if (existsSync(selected.sessionFile) || sessionFiles.length !== 0) fail("Pi created a transcript before the first assistant response");
	return {
		pass: true,
		stateRetainedInProcess: true,
		transcriptCreatedBeforeFirstAssistant: false,
		providerStreamCalls: 0,
	};
}

async function oauthRpcCase() {
	const profile = join(temporary, "oauth-rpc-profile");
	const sessionDirectory = join(temporary, "oauth-rpc-sessions");
	const streamLog = join(temporary, "oauth-rpc-stream.jsonl");
	writeJson(join(profile, "auth.json"), profileAuth(Date.now() + 60 * 60 * 1000));
	writeJson(join(profile, "models-store.json"), {});
	const session = { id: "44444444-4444-4444-8444-444444444444", directory: sessionDirectory };
	const first = await runPi("oauth-rpc-first", {
		profile,
		session,
		commands: [
			{ id: "catalog", type: "get_available_models" },
			{ id: "select", type: "set_model", provider: "hitch-fixture-oauth", modelId: "oauth-reasoning" },
			{ id: "levels", type: "get_available_thinking_levels" },
			{ id: "thinking", type: "set_thinking_level", level: "medium" },
			{ id: "turn", type: "prompt", message: "HITCH_FIXTURE_OAUTH_RPC", _waitForTerminal: true },
			{ id: "last", type: "get_last_assistant_text" },
			{ id: "state", type: "get_state" },
		],
		env: { HITCH_FIXTURE_STREAM_LOG: streamLog },
	});
	const catalog = assertCatalog(first.events, EXPECTED_MODELS, "oauth-rpc-first");
	exactSet(response(first.events, "levels").data.levels, STANDARD_REASONING_LEVELS, "oauth rpc reasoning levels");
	response(first.events, "turn");
	if (response(first.events, "last").data?.text !== "HITCH_FIXTURE_ASSISTANT") fail("OAuth RPC response mismatch");
	const selected = state(first.events, "state");
	if (selected.model?.provider !== "hitch-fixture-oauth" || selected.model?.id !== "oauth-reasoning" || selected.thinkingLevel !== "medium") {
		fail("OAuth model/thinking selection did not persist in the first RPC controller");
	}
	const settlement = assertAgentSettled(first.events, "last", 1, "oauth rpc turn");
	const streamCalls = readJsonLines(streamLog);
	if (streamCalls.length !== 1 || streamCalls[0]?.model !== "hitch-fixture-oauth/oauth-reasoning") {
		fail(`OAuth RPC did not invoke the selected model exactly once: ${JSON.stringify(streamCalls)}`);
	}
	const firstDurableSync = durableSync(selected.sessionFile);
	rmSync(join(profile, "settings.json"), { force: true });
	const second = await runPi("oauth-rpc-second", {
		profile,
		session: { path: selected.sessionFile, directory: sessionDirectory },
		commands: [
			{ id: "catalog", type: "get_available_models" },
			{ id: "restored", type: "get_state" },
		],
	});
	const secondCatalog = assertCatalog(second.events, EXPECTED_MODELS, "oauth-rpc-second");
	if (secondCatalog.digest !== catalog.digest) fail("OAuth RPC catalog digest changed across controllers");
	const restored = state(second.events, "restored");
	if (restored.model?.provider !== "hitch-fixture-oauth" || restored.model?.id !== "oauth-reasoning" || restored.thinkingLevel !== "medium" || restored.sessionFile !== selected.sessionFile) {
		fail("OAuth model/thinking/session did not restore in a fresh RPC controller");
	}
	const secondDurableSync = durableSync(selected.sessionFile);
	return {
		pass: true,
		model: "hitch-fixture-oauth/oauth-reasoning",
		thinking: "medium",
		catalogSha256: catalog.digest,
		selectedPromptedOverRpc: true,
		restoredAcrossFreshController: true,
		settlement,
		providerStreamCalls: streamCalls.length,
		durableSync: { first: firstDurableSync, second: secondDurableSync },
	};
}

async function retrySettlementCase() {
	const profile = join(temporary, "retry-profile");
	const streamLog = join(temporary, "retry-stream.jsonl");
	writeJson(join(profile, "auth.json"), profileAuth(Date.now() + 60 * 60 * 1000));
	writeJson(join(profile, "models-store.json"), {});
	writeJson(join(profile, "settings.json"), { retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 } });
	const result = await runPi("retry-settlement", {
		profile,
		session: null,
		commands: [
			{ id: "select", type: "set_model", provider: "hitch-fixture-key", modelId: "plain-text" },
			{ id: "turn", type: "prompt", message: "HITCH_FIXTURE_RETRY", _waitForTerminal: true },
			{ id: "last", type: "get_last_assistant_text" },
		],
		env: { HITCH_FIXTURE_RETRY_ONCE: "1", HITCH_FIXTURE_STREAM_LOG: streamLog },
	});
	response(result.events, "turn");
	if (response(result.events, "last").data?.text !== "HITCH_FIXTURE_ASSISTANT") fail("retry did not reach final assistant response");
	const streamCalls = readJsonLines(streamLog);
	if (streamCalls.length !== 2 || streamCalls.some((call) => call.model !== "hitch-fixture-key/plain-text")) {
		fail(`retry did not make exactly two plain-model calls: ${JSON.stringify(streamCalls)}`);
	}
	const settlement = assertAgentSettled(result.events, "last", 2, "automatic retry");
	if (countEvents(result.events, "auto_retry_start") !== 1 || countEvents(result.events, "auto_retry_end") !== 1) {
		fail("automatic retry lifecycle events did not occur exactly once");
	}
	return {
		pass: true,
		providerStreamCalls: streamCalls.length,
		autoRetryStarts: 1,
		autoRetryEnds: 1,
		settlement,
	};
}

function readRefreshLog(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForFileLines(path, count, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (readRefreshLog(path).length >= count) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	fail(`timed out waiting for ${count} line(s) in ${basename(path)}`);
}

function startOAuthWorker(name, environment) {
	return new Promise((resolveWorker, rejectWorker) => {
		const child = spawn(process.execPath, [oauthWorker], {
			cwd: workspace,
			env: minimalEnvironment(environment.PI_CODING_AGENT_DIR, environment),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", rejectWorker);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			try {
				if (code !== 0) fail(`${name}: OAuth worker exited code=${code} signal=${signal}; stderr=${stderr.trim()}`);
				assertNoSyntheticValue(stdout, `${name} stdout`);
				assertNoSyntheticValue(stderr, `${name} stderr`);
				const lines = stdout.trim().split("\n").filter(Boolean);
				if (lines.length !== 1) fail(`${name}: expected one worker result`);
				resolveWorker(JSON.parse(lines[0]));
			} catch (error) {
				rejectWorker(error);
			}
		});
	});
}

async function concurrentSessionOpenCase() {
	const profile = join(temporary, "session-concurrency-profile");
	const sessionDirectory = join(temporary, "session-concurrency-sessions");
	const streamLog = join(temporary, "session-concurrency-stream.jsonl");
	writeJson(join(profile, "auth.json"), profileAuth(Date.now() + 60 * 60 * 1000));
	writeJson(join(profile, "models-store.json"), {});
	const session = { id: "22222222-2222-4222-8222-222222222222", directory: sessionDirectory };
	const seed = await runPi("session-concurrency-seed", {
		profile,
		session,
		commands: [
			{ id: "select", type: "set_model", provider: "hitch-fixture-key", modelId: "plain-text" },
			{ id: "turn", type: "prompt", message: "HITCH_FIXTURE_SEED", _waitForTerminal: true },
			{ id: "state", type: "get_state" },
		],
		env: { HITCH_FIXTURE_STREAM_LOG: streamLog },
	});
	const path = state(seed.events, "state").sessionFile;
	if (!existsSync(path)) fail("session concurrency seed was not persisted");
	const seedDurableSync = durableSync(path);
	const same = { path, directory: sessionDirectory };
	const beforeLines = readFileSync(path, "utf8").trim().split("\n").length;
	const invocation = (index) => runPi(`session-concurrency-${index}`, {
		profile,
		session: same,
		commands: [
			{ id: `turn-${index}`, type: "prompt", message: `HITCH_FIXTURE_CONCURRENT_${index}`, _waitForTerminal: true },
		],
		env: { HITCH_FIXTURE_STREAM_DELAY_MS: "300", HITCH_FIXTURE_STREAM_LOG: streamLog },
	});
	await Promise.all([invocation(1), invocation(2)]);
	const streamCalls = readJsonLines(streamLog);
	if (streamCalls.length !== 3) fail(`session concurrency expected three provider calls, got ${streamCalls.length}`);
	let parseSucceeded = true;
	let afterLines = 0;
	let siblingBranches = false;
	let concurrentTurnsOnSelectedBranch = 0;
	try {
		const lines = readFileSync(path, "utf8").trim().split("\n");
		afterLines = lines.length;
		const entries = lines.map((line) => JSON.parse(line));
		const added = entries.slice(beforeLines);
		const addedUsers = added.filter((entry) => entry.type === "message" && entry.message?.role === "user");
		if (addedUsers.length !== 2) fail(`expected two concurrent user entries, got ${addedUsers.length}`);
		siblingBranches = addedUsers[0].parentId === addedUsers[1].parentId;
		if (!siblingBranches) fail("concurrent session writers did not create the expected sibling branches");
		const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
		const concurrentIds = new Set(addedUsers.map((entry) => entry.id));
		let cursor = entries.at(-1);
		while (cursor) {
			if (concurrentIds.has(cursor.id)) concurrentTurnsOnSelectedBranch++;
			cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
		}
		if (concurrentTurnsOnSelectedBranch !== 1) {
			fail(`expected one of two concurrent Turns on selected branch, got ${concurrentTurnsOnSelectedBranch}`);
		}
	} catch {
		parseSucceeded = false;
	}
	if (!parseSucceeded) fail("concurrent session output was not valid JSONL or branch analysis failed");
	return {
		pass: true,
		processes: 2,
		syntheticStreamDelayMs: 300,
		sameSessionFile: true,
		jsonlParseSucceeded: parseSucceeded,
		linesBefore: beforeLines,
		linesAfter: afterLines,
		siblingBranches,
		concurrentTurnsOnSelectedBranch,
		concurrentTurnsOmittedFromSelectedBranch: 1,
		providerStreamCalls: streamCalls.length,
		seedDurableSync,
		productionDisposition: "forbidden-by-one-global-controller-gate",
	};
}

async function concurrencyCase(failRefresh) {
	const name = failRefresh ? "oauth-failure" : "oauth-success";
	const profile = join(temporary, `${name}-profile`);
	const authPath = join(profile, "auth.json");
	const readyLog = join(temporary, `${name}-ready.jsonl`);
	const startMarker = join(temporary, `${name}-start`);
	const refreshLog = join(temporary, `${name}-refresh.jsonl`);
	const initial = `${JSON.stringify(profileAuth(0), null, 2)}\n`;
	mkdirSync(profile, { recursive: true, mode: 0o700 });
	writeFileSync(authPath, initial, { mode: 0o600 });
	const workerEnvironment = {
		PI_CODING_AGENT_DIR: profile,
		HITCH_PI_PACKAGE_ROOT: piPackageRootForWorkers,
		HITCH_AUTH_PATH: authPath,
		HITCH_READY_LOG: readyLog,
		HITCH_START_MARKER: startMarker,
		HITCH_REFRESH_LOG: refreshLog,
		...(failRefresh ? { HITCH_REFRESH_FAIL: "1" } : {}),
	};
	const leftPromise = startOAuthWorker(`${name}-1`, workerEnvironment);
	const rightPromise = startOAuthWorker(`${name}-2`, workerEnvironment);
	await waitForFileLines(readyLog, 2, 5_000);
	writeFileSync(startMarker, "start\n", { mode: 0o600 });
	const [left, right] = await Promise.all([leftPromise, rightPromise]);
	if (left.model !== "hitch-fixture-oauth/oauth-reasoning") fail(`${name}-1: wrong worker model`);
	if (right.model !== "hitch-fixture-oauth/oauth-reasoning") fail(`${name}-2: wrong worker model`);
	if (failRefresh ? (left.success || right.success) : (!left.success || !right.success)) {
		fail(`${name}: unexpected worker auth outcomes ${left.success}/${right.success}`);
	}
	const refreshes = readRefreshLog(refreshLog);
	const finalRaw = readFileSync(authPath, "utf8");
	const finalAuth = JSON.parse(finalRaw)["hitch-fixture-oauth"];
	if ((statSync(authPath).mode & 0o777) !== 0o600) fail(`${name}: auth.json mode is not 0600`);
	if (existsSync(`${authPath}.lock`)) fail(`${name}: auth lock remained after exit`);

	if (failRefresh) {
		if (refreshes.length !== 2) fail(`oauth failure: expected two serialized attempts, got ${refreshes.length}`);
		if (finalRaw !== initial) fail("oauth failure mutated the credential fixture");
	} else {
		if (refreshes.length !== 1) fail(`oauth success: expected one global refresh, got ${refreshes.length}`);
		if (finalAuth.refresh !== "fixture-refresh-0-rotated" || finalAuth.access !== "HITCH_SYNTHETIC_OAUTH_ACCESS_REFRESHED") {
			fail("oauth success did not persist the rotated credential under the lock");
		}
		if (!(finalAuth.expires > Date.now())) fail("oauth success persisted an expired credential");
	}

	return {
		pass: true,
		processes: 2,
		bothProcessesReadyBeforeBarrier: true,
		refreshAttempts: refreshes.length,
		finalCredential: failRefresh ? "byte-identical-expired-fixture" : "single-rotation-valid-oauth",
		validJson: true,
		mode: "0600",
		lockReleased: true,
		exactModelPerProcess: "hitch-fixture-oauth/oauth-reasoning",
		authResolvedProcesses: failRefresh ? 0 : 2,
		serializedPersistenceOnly: true,
		atomicCrashSafetyProven: false,
	};
}

function authCrashCase() {
	const profile = join(temporary, "auth-crash-profile");
	const authPath = join(profile, "auth.json");
	const initial = `${JSON.stringify(profileAuth(0), null, 2)}\n`;
	mkdirSync(profile, { recursive: true, mode: 0o700 });
	writeFileSync(authPath, initial, { mode: 0o600 });
	const result = spawnSync(process.execPath, [authCrashWorker], {
		cwd: workspace,
		encoding: "utf8",
		env: minimalEnvironment(profile, {
			HITCH_PI_PACKAGE_ROOT: piPackageRootForWorkers,
			HITCH_AUTH_PATH: authPath,
		}),
		timeout: 10_000,
	});
	if (result.signal !== "SIGKILL") {
		fail(`auth crash worker did not terminate at the injected partial write: status=${result.status} signal=${result.signal} stderr=${result.stderr}`);
	}
	const after = readFileSync(authPath, "utf8");
	if (after === initial) fail("fault-injected in-place auth write left the original bytes intact unexpectedly");
	let validJson = true;
	try {
		JSON.parse(after);
	} catch {
		validJson = false;
	}
	if (validJson) fail("fault-injected in-place auth write unexpectedly remained valid JSON");
	return {
		pass: true,
		injectedFailure: "SIGKILL-during-in-place-write",
		originalBytesPreserved: false,
		validJsonAfterCrash: false,
		atomicCrashSafetyPresent: false,
		productionDisposition: "blocked-until-auth-write-uses-fsync-temp-rename-and-parent-directory-fsync",
	};
}

try {
	mkdirSync(workspace, { recursive: true });
	const piExecutable = realpathSync(commandOutput("which", ["pi"]));
	const piPackageRoot = resolve(dirname(piExecutable), "..");
	piPackageRootForWorkers = piPackageRoot;
	const piPackage = JSON.parse(readFileSync(join(piPackageRoot, "package.json"), "utf8"));
	if (piPackage.name !== "@earendil-works/pi-coding-agent" || piPackage.version !== PI_VERSION) {
		fail(`unexpected Pi package ${piPackage.name}@${piPackage.version}`);
	}
	const piTree = treeSha256(piPackageRoot);
	if (piTree !== PI_TREE_SHA256) fail(`Pi tree digest drift: ${piTree}`);
	const piDependencyClosure = treeSha256(piPackageRoot, true);
	if (piDependencyClosure !== PI_DEPENDENCY_CLOSURE_SHA256) {
		fail(`Pi dependency-closure digest drift: ${piDependencyClosure}`);
	}

	const cases = {
		modelAndSession: await modelAndSessionCase(),
		preFlushTranscript: await preFlushCase(),
		oauthModelRpc: await oauthRpcCase(),
		retrySettlement: await retrySettlementCase(),
		oauthConcurrencySuccess: await concurrencyCase(false),
		oauthConcurrencyFailure: await concurrencyCase(true),
		authWriteCrash: authCrashCase(),
		concurrentSessionOpen: await concurrentSessionOpenCase(),
	};
	const syntheticProviderCallsMade = Object.values(cases).reduce(
		(total, testCase) => total + (testCase.providerStreamCalls ?? 0),
		0,
	);
	if (syntheticProviderCallsMade !== 8) fail(`unexpected total provider stream calls: ${syntheticProviderCallsMade}`);
	const manifest = {
		schemaVersion: 1,
		type: "hitch.phase0.runtime-evidence",
		createdAt: new Date().toISOString(),
		inputs: {
			pi: commandOutput("pi", ["--version"]),
			piPackageTreeSha256: piTree,
			piDependencyClosureSha256: piDependencyClosure,
			node: process.version,
			npm: commandOutput("npm", ["--version"]),
			kernel: commandOutput("uname", ["-r"]),
			providerFixtureSha256: sha256(fixtureExtension),
			oauthWorkerSha256: sha256(oauthWorker),
			authCrashWorkerSha256: sha256(authCrashWorker),
			runnerSha256: sha256(fileURLToPath(import.meta.url)),
		},
		controls: {
			realCredentialsUsed: false,
			realProviderCallsMade: false,
			syntheticProviderCallsMade,
			offline: true,
			telemetry: false,
			ambientHomeUsed: false,
		},
		cases,
		decision: {
			controllerConcurrency: "one-global-active-controller",
			transcriptDurability: "Hitch-fsync-file-and-parent-directory-after-agent-settled-and-clean-exit",
			authPersistence: "serialized-but-not-crash-atomic-in-pinned-Pi",
			phase0FinalDisposition: "blocked-on-crash-atomic-auth-persistence-and-opt-in-live-provider-checks",
			reason: "The deterministic subgate passes and exposes Pi's in-place auth-write failure; it does not waive the security floor.",
		},
		outcome: "deterministic-subgate-pass-with-explicit-final-blocker",
	};
	const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
	assertNoSyntheticValue(manifestJson, "runtime evidence");
	writeFileSync(evidencePath, manifestJson, { mode: 0o600 });
	process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
