#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { activeSandboxUnitCount, executeSandboxRequest } from "./sandbox-backend.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const extension = join(here, "hitch-sandbox.ts");
const backend = join(here, "sandbox-backend.mjs");
const workerSource = join(here, "sandbox-worker.mjs");
const helperSource = join(here, "secure-bwrap-helper.c");
const provider = join(here, "provider-fixture.ts");
const evidencePath = join(here, "P0-SANDBOX-EVIDENCE.json");
const temporary = mkdtempSync(join(tmpdir(), "hitch-p0-sandbox-"));
const workspace = join(temporary, "workspace");
const inbox = join(temporary, "inbox");
const publishRoot = join(temporary, "publish");
const otherWorkspace = join(temporary, "other-user-workspace");
const profile = join(temporary, "profile");
const stagedWorker = join(temporary, "sandbox-worker.mjs");
const compiledHelper = join(temporary, "secure-bwrap-helper");
const backendLog = join(temporary, "backend.jsonl");
const providerLog = join(temporary, "provider.jsonl");
const turnHandle = "0123456789abcdef0123456789abcdef";
const PI_VERSION = "0.84.1";
const PI_TREE_SHA256 = "7298ead16e553a8ffc372ca6a5a17ccfd711ae0887830134255dcea08be55bba";
const PI_DEPENDENCY_CLOSURE_SHA256 = "6d2055eaeef6823fd4b6edc062314e383fc6e233a4634a13e868a86eaebbcec4";
const ARTIFACT_SHA256 = Object.freeze({
	extension: "9cc0929c921c47632c2ba53701c95dd5fd195712e1671779931bdaf7c59bf1d8",
	backend: "72d9d2e11012a77dda0491253cc346c5417cfd7a67a0e7042dd79ea7cb91a2c1",
	worker: "7c591aeaa72ca63ddb09db42ee0562505ea3f416264f64870e69e9d8970f2cd9",
	helperSource: "766c4e48ab4862f5f9afc394b15c48a69ed6988fc32267e94f0512f225b07c6f",
	compiledHelper: "9428f425beb6a544616920f66b74c6d7d4b2b92e9ccf3923a55f9796cf513027",
	provider: "40f1cde139aaf0d47e3f6b640dbb7436abc999031112552fef2683c32d1bc323",
});
const EXPECTED_TOOLS = ["bash", "edit", "find", "grep", "hitch_publish", "ls", "read", "write"];
const CONTROLLER_SECRET = "HITCH_P0_CONTROLLER_SECRET_VALUE";
const CHANNEL_SECRET = "HITCH_P0_CHANNEL_SECRET_VALUE";
const PROVIDER_SECRET = "P0_PROVIDER_SECRET_VALUE";
const SEQUENCE_CONTROLLER_NONCE = "1".repeat(32);
const CANCELLATION_CONTROLLER_NONCE = "2".repeat(32);
const INITIALIZATION_CONTROLLER_NONCE = "3".repeat(32);
const FAILED_STARTUP_CONTROLLER_NONCE = "4".repeat(32);
const IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function fail(message) {
	throw new Error(message);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
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
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: temporary, LANG: "C" },
		timeout: 15_000,
	});
	if (result.status !== 0) fail(`${basename(command)} failed`);
	return result.stdout.trim();
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function readJsonLines(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function exactSet(actual, expected, label) {
	const left = [...actual].sort();
	const right = [...expected].sort();
	if (JSON.stringify(left) !== JSON.stringify(right)) fail(`${label} differed`);
}

function assertSanitized(value, label) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	for (const forbidden of [CONTROLLER_SECRET, CHANNEL_SECRET, PROVIDER_SECRET, workspace, inbox, publishRoot, profile, temporary]) {
		if (text.includes(forbidden)) fail(`${label} exposed forbidden material`);
	}
}

function baseConfiguration(overrides = {}) {
	return {
		workspace,
		inbox,
		publishRoot,
		worker: stagedWorker,
		helper: compiledHelper,
		log: backendLog,
		turnHandle,
		workerSha256: sha256(stagedWorker),
		helperSha256: sha256(compiledHelper),
		temporaryBytes: 4 * 1024 * 1024,
		memoryBytes: 256 * 1024 * 1024,
		maximumProcesses: 32,
		wallMilliseconds: 8_000,
		...overrides,
	};
}

function minimalEnvironment(mode, controllerNonce, overrides = {}) {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: temporary,
		LANG: "C.UTF-8",
		NO_COLOR: "1",
		PI_CODING_AGENT_DIR: profile,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		HITCH_P0_WORKSPACE: workspace,
		HITCH_P0_INBOX: inbox,
		HITCH_P0_PUBLISH_ROOT: publishRoot,
		HITCH_P0_WORKER: stagedWorker,
		HITCH_P0_HELPER: compiledHelper,
		HITCH_P0_LOG: backendLog,
		HITCH_P0_TURN_HANDLE: turnHandle,
		HITCH_P0_CONTROLLER_NONCE: controllerNonce,
		HITCH_P0_WORKER_SHA256: sha256(stagedWorker),
		HITCH_P0_HELPER_SHA256: sha256(compiledHelper),
		HITCH_P0_EXTENSION_SHA256: sha256(extension),
		HITCH_P0_BACKEND_SHA256: sha256(backend),
		HITCH_P0_PROVIDER_LOG: providerLog,
		HITCH_P0_PROVIDER_MODE: mode,
		HITCH_P0_CONTROLLER_SECRET: CONTROLLER_SECRET,
		HITCH_P0_CHANNEL_SECRET: CHANNEL_SECRET,
		...overrides,
	};
}

function piArgs() {
	return [
		"--mode", "rpc",
		"--offline",
		"--no-session",
		"--no-extensions",
		"--extension", extension,
		"--extension", provider,
		"--no-builtin-tools",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-approve",
	];
}

function response(events, id, success = true) {
	const found = events.find((event) => event?.type === "response" && event?.id === id);
	if (!found || found.success !== success) fail(`unexpected RPC response ${id}`);
	return found;
}

function freshStartupAttestations(controllerNonce) {
	return readJsonLines(backendLog).filter((record) =>
		record.type === "startup-attestation" && record.ready === true &&
		record.controllerNonce === controllerNonce,
	);
}

function waitForFreshStartupAttestation(child, controllerNonce, name) {
	return new Promise((resolvePromise, rejectPromise) => {
		const deadline = Date.now() + 10_000;
		const inspect = () => {
			const matches = freshStartupAttestations(controllerNonce);
			if (matches.length === 1) return resolvePromise(matches[0]);
			if (matches.length > 1 || child.exitCode !== null || Date.now() >= deadline) {
				child.kill("SIGKILL");
				return rejectPromise(new Error(`${name} lacked a unique fresh startup attestation`));
			}
			setTimeout(inspect, 20);
		};
		inspect();
	});
}

function runPiSequence(name, commands, mode = "sequence", controllerNonce = SEQUENCE_CONTROLLER_NONCE) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("pi", piArgs(), {
			cwd: workspace,
			env: minimalEnvironment(mode, controllerNonce),
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let buffer = "";
		let index = 0;
		let responseSeen = false;
		let settledSeen = false;
		const events = [];
		const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
		const send = () => {
			if (index >= commands.length) return child.stdin.end();
			if (commands[index]?._requireReady) {
				if (freshStartupAttestations(controllerNonce).length !== 1) {
					child.kill("SIGKILL");
					return rejectPromise(new Error(`${name} would submit work before startup attestation`));
				}
			}
			const outgoing = { ...commands[index] };
			delete outgoing._waitForSettled;
			delete outgoing._requireReady;
			child.stdin.write(`${JSON.stringify(outgoing)}\n`);
		};
		const advance = () => {
			if (!responseSeen || (commands[index]?._waitForSettled && !settledSeen)) return;
			index++;
			responseSeen = false;
			settledSeen = false;
			send();
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			buffer += chunk;
			while (buffer.includes("\n")) {
				const newline = buffer.indexOf("\n");
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				const event = JSON.parse(line);
				events.push(event);
				if (event.type === "response" && event.id === commands[index]?.id) responseSeen = true;
				if (commands[index]?._waitForSettled && event.type === "agent_settled") settledSeen = true;
				advance();
			}
		});
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", rejectPromise);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			try {
				if (code !== 0 || signal !== null || buffer.trim()) fail(`${name} did not exit cleanly`);
				assertSanitized(stdout, `${name} RPC`);
				assertSanitized(stderr, `${name} stderr`);
				resolvePromise(events);
			} catch (error) { rejectPromise(error); }
		});
		waitForFreshStartupAttestation(child, controllerNonce, name).then(send, rejectPromise);
	});
}

async function runCancellationCase() {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("pi", piArgs(), {
			cwd: workspace,
			env: minimalEnvironment("cancel", CANCELLATION_CONTROLLER_NONCE),
			stdio: ["pipe", "pipe", "pipe"],
		});
		let buffer = "";
		let stderr = "";
		const events = [];
		let selected = false;
		let promptSent = false;
		let abortSent = false;
		let abortResponse = false;
		let settled = false;
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const newline = buffer.indexOf("\n");
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				const event = JSON.parse(line);
				events.push(event);
				if (event.type === "response" && event.id === "select") selected = event.success === true;
				if (selected && !promptSent) {
					if (freshStartupAttestations(CANCELLATION_CONTROLLER_NONCE).length !== 1) {
						child.kill("SIGKILL");
						return rejectPromise(new Error("cancellation prompt would precede startup attestation"));
					}
					promptSent = true;
					child.stdin.write(`${JSON.stringify({ id: "turn", type: "prompt", message: "cancel fixture" })}\n`);
				}
				if (event.type === "tool_execution_start" && event.toolName === "bash" && !abortSent) {
					abortSent = true;
					child.stdin.write(`${JSON.stringify({ id: "abort", type: "abort" })}\n`);
				}
				if (event.type === "response" && event.id === "abort") abortResponse = event.success === true;
				if (event.type === "agent_settled") {
					settled = true;
					child.stdin.end();
				}
			}
		});
		child.once("error", rejectPromise);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			try {
				if (!selected || !promptSent || !abortSent || !abortResponse || !settled || code !== 0 || signal !== null) {
					fail("cancellation RPC lifecycle failed");
				}
				assertSanitized(stderr, "cancellation stderr");
				resolvePromise({
					pass: true,
					abortResponse: true,
					agentSettled: true,
					toolEnded: events.some((event) => event.type === "tool_execution_end" && event.toolName === "bash"),
				});
			} catch (error) { rejectPromise(error); }
		});
		waitForFreshStartupAttestation(child, CANCELLATION_CONTROLLER_NONCE, "cancellation controller").then(() => {
			child.stdin.write(`${JSON.stringify({ id: "select", type: "set_model", provider: "hitch-p0-sandbox", modelId: "sandbox-image" })}\n`);
		}, rejectPromise);
	});
}

async function resourceCases(config) {
	const probe = await executeSandboxRequest(config, { operation: "probe", input: {} });
	if (
		probe.cwd !== "/workspace" || probe.hostHomeVisible || probe.networkNamespaceHasExternalInterface ||
		!probe.networkDenied || !probe.inboxWritable || probe.publishVisible
	) fail("backend isolation probe failed");
	const otherUser = await executeSandboxRequest(config, {
		operation: "bash",
		input: { command: `test ! -e ${JSON.stringify(otherWorkspace)} && printf HITCH_OTHER_USER_DENIED`, timeoutMs: 2000 },
	});
	if (otherUser.output !== "HITCH_OTHER_USER_DENIED" || otherUser.exitCode !== 0) fail("other-user workspace was visible");
	const temp = await executeSandboxRequest(
		baseConfiguration({ temporaryBytes: 1024 * 1024 }),
		{ operation: "bash", input: { command: "dd if=/dev/zero of=/tmp/fill bs=1048576 count=8", timeoutMs: 4000 } },
	);
	if (temp.exitCode === 0) fail("temporary storage limit was not enforced");
	const tasks = await executeSandboxRequest(
		baseConfiguration({ maximumProcesses: 16 }),
		{ operation: "bash", input: { command: "/usr/bin/node -e 'const{spawn}=require(\"node:child_process\");let n=0,d=0;for(let i=0;i<64;i++){const c=spawn(\"/bin/sleep\",[\"1\"]);c.on(\"spawn\",()=>n++);c.on(\"error\",()=>{if(++d===64)done()});c.on(\"close\",()=>{if(++d===64)done()})}function done(){console.log(n)}setTimeout(done,1500)'", timeoutMs: 4000 } },
	);
	const started = Number.parseInt(tasks.output.trim().split("\n").at(-1), 10);
	if (tasks.exitCode === 0 && (!Number.isFinite(started) || started >= 64)) fail("process limit was not enforced");
	let outputLimited = false;
	try {
		await executeSandboxRequest(config, { operation: "bash", input: { command: "/usr/bin/node -e 'process.stdout.write(\"x\".repeat(2*1024*1024))'", timeoutMs: 4000 } });
	} catch { outputLimited = true; }
	if (!outputLimited) fail("output limit was not enforced");
	let wallLimited = false;
	try {
		await executeSandboxRequest(
			baseConfiguration({ wallMilliseconds: 500 }),
			{ operation: "bash", input: { command: "sleep 5", timeoutMs: 5000 } },
		);
	} catch { wallLimited = true; }
	if (!wallLimited) fail("wall limit was not enforced");
	let memoryLimited = false;
	try {
		await executeSandboxRequest(
			baseConfiguration({ memoryBytes: 96 * 1024 * 1024 }),
			{ operation: "bash", input: { command: "/usr/bin/node -e 'const x=Buffer.alloc(512*1024*1024,1);console.log(x.length)'", timeoutMs: 5000 } },
		);
	} catch { memoryLimited = true; }
	if (!memoryLimited) fail("memory limit was not enforced");
	const abortController = new AbortController();
	setTimeout(() => abortController.abort(), 300);
	let cancellationCleaned = false;
	try {
		await executeSandboxRequest(
			config,
			{ operation: "bash", input: { command: "sleep 30 & child=$!; wait $child", timeoutMs: 5000 } },
			abortController.signal,
		);
	} catch { cancellationCleaned = true; }
	if (!cancellationCleaned || activeSandboxUnitCount() !== 0) fail("standalone cancellation cleanup failed");
	writeFileSync(join(workspace, "publish-source.txt"), "publish source\n", { mode: 0o600 });
	mkdirSync(join(workspace, "publish-real-dir"), { mode: 0o700 });
	writeFileSync(join(workspace, "publish-real-dir", "nested.txt"), "nested source\n", { mode: 0o600 });
	symlinkSync("publish-source.txt", join(workspace, "publish-symlink.txt"));
	symlinkSync("publish-real-dir", join(workspace, "publish-dir-link"));
	linkSync(join(workspace, "publish-source.txt"), join(workspace, "publish-hardlink.txt"));
	for (const path of ["publish-symlink.txt", "publish-dir-link/nested.txt", "publish-hardlink.txt"]) {
		let rejected = false;
		try {
			await executeSandboxRequest(config, {
				operation: "hitch_publish",
				input: { path, artifactId: createHash("sha256").update(path).digest("hex").slice(0, 32) },
			});
		} catch { rejected = true; }
		if (!rejected) fail("unsafe publication source was accepted");
	}
	unlinkSync(join(workspace, "publish-hardlink.txt"));
	unlinkSync(join(workspace, "publish-symlink.txt"));
	unlinkSync(join(workspace, "publish-dir-link"));
	unlinkSync(join(workspace, "publish-source.txt"));
	const mutationPath = join(workspace, "publish-mutation.bin");
	writeFileSync(mutationPath, Buffer.alloc(32 * 1024 * 1024, 0x61), { mode: 0o600 });
	const mutator = spawn("/bin/bash", ["-c", "while :; do /usr/bin/touch -m -- \"$1\"; done", "p0-mutator", mutationPath], {
		env: { PATH: "/usr/bin:/bin", LANG: "C" },
		stdio: "ignore",
	});
	await new Promise((resolve) => setTimeout(resolve, 25));
	let mutationRejected = false;
	try {
		await executeSandboxRequest(config, {
			operation: "hitch_publish",
			input: { path: "publish-mutation.bin", artifactId: "f".repeat(32) },
		});
	} catch { mutationRejected = true; }
	mutator.kill("SIGKILL");
	await new Promise((resolve) => mutator.once("close", resolve));
	unlinkSync(mutationPath);
	if (!mutationRejected) fail("mutating publication source was accepted");
	if (readdirSync(publishRoot).length !== 0) fail("rejected publication left an artifact");
	const abortedArtifactId = "e".repeat(32);
	const abortedSource = join(workspace, "publish-aborted.bin");
	const operationTemporary = join(publishRoot, `${abortedArtifactId}.tmp`);
	writeFileSync(abortedSource, Buffer.alloc(50 * 1024 * 1024, 0x62), { mode: 0o600 });
	const publicationAbort = new AbortController();
	publicationAbort.abort();
	let alreadyAbortedRejected = false;
	try {
		await executeSandboxRequest(
			config,
			{ operation: "hitch_publish", input: { path: "publish-aborted.bin", artifactId: "d".repeat(32) } },
			publicationAbort.signal,
		);
	} catch { alreadyAbortedRejected = true; }
	if (!alreadyAbortedRejected || activeSandboxUnitCount() !== 0 || readdirSync(publishRoot).length !== 0) {
		fail("already-aborted publication was not rejected before launch");
	}
	const midCopyAbort = new AbortController();
	let midCopyRejected = false;
	let midCopyCompleted = false;
	const publication = executeSandboxRequest(
		config,
		{ operation: "hitch_publish", input: { path: "publish-aborted.bin", artifactId: abortedArtifactId } },
		midCopyAbort.signal,
	).then(
		() => { midCopyCompleted = true; },
		() => { midCopyRejected = true; },
	);
	const temporaryDeadline = Date.now() + 5000;
	while (!existsSync(operationTemporary) && !midCopyCompleted && !midCopyRejected && Date.now() < temporaryDeadline) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	if (!existsSync(operationTemporary)) {
		midCopyAbort.abort();
		await publication;
		fail("publication copier did not expose its operation-owned temporary file");
	}
	midCopyAbort.abort();
	await publication;
	unlinkSync(abortedSource);
	if (!midCopyRejected || midCopyCompleted || activeSandboxUnitCount() !== 0 || readdirSync(publishRoot).length !== 0) {
		fail("aborted publication left an operation-owned temporary artifact");
	}
	return {
		pass: true,
		workspaceWritable: true,
		inboxReadOnly: true,
		hostHomeDenied: true,
		otherUserWorkspaceDenied: true,
		externalNetworkDenied: true,
		temporaryStorageBounded: true,
		processCountBounded: true,
		combinedOutputBounded: true,
		wallTimeBounded: true,
		memoryBounded: true,
		cpuQuotaAttested: "50%",
		cancellationProcessTreeCleanup: true,
		symlinkPublicationRejected: true,
		intermediateSymlinkPublicationRejected: true,
		hardlinkPublicationRejected: true,
		mutatingPublicationRejected: true,
		alreadyAbortedPublicationRejected: true,
		midCopyPublicationAbortCleanup: true,
	};
}

function initializationFailureCase() {
	const sentinel = join(temporary, "host-fallback-sentinel");
	const result = spawnSync("pi", piArgs(), {
		cwd: workspace,
		encoding: "utf8",
		input: `${JSON.stringify({ id: "bash", type: "bash", command: `printf bad > ${sentinel}` })}\n`,
		env: minimalEnvironment("sequence", INITIALIZATION_CONTROLLER_NONCE, {
			HITCH_P0_EXTENSION_SHA256: "0".repeat(64),
		}),
		timeout: 10_000,
	});
	if (result.status === 0 || existsSync(sentinel)) fail("extension initialization failure did not fail closed");
	assertSanitized(result.stdout, "initialization failure RPC");
	return { pass: true, rejectedBeforeRpc: true, hostFallbackExecuted: false };
}

function failedStartupFreshnessCase() {
	return new Promise((resolvePromise, rejectPromise) => {
		const priorProbeCount = readJsonLines(backendLog).filter((record) => record.operation === "probe").length;
		const priorProviderCount = readJsonLines(providerLog).length;
		const sentinel = join(temporary, "stale-attestation-sentinel");
		const child = spawn("pi", piArgs(), {
			cwd: workspace,
			env: minimalEnvironment("sequence", FAILED_STARTUP_CONTROLLER_NONCE, {
				HITCH_P0_FORCE_STARTUP_PROBE_FAILURE: "1",
			}),
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let observedSwallowedFailure = false;
		let settled = false;
		const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
		const rejectOnce = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGKILL");
			rejectPromise(error);
		};
		const inspect = () => {
			if (settled || observedSwallowedFailure) return;
			const probeCount = readJsonLines(backendLog).filter((record) => record.operation === "probe").length;
			if (probeCount > priorProbeCount) {
				if (
					child.exitCode !== null || child.signalCode !== null ||
					freshStartupAttestations(FAILED_STARTUP_CONTROLLER_NONCE).length !== 0 ||
					freshStartupAttestations(SEQUENCE_CONTROLLER_NONCE).length !== 1
				) return rejectOnce(new Error("failed startup freshness fixture did not expose the stale-attestation case"));
				observedSwallowedFailure = true;
				child.stdin.end();
				return;
			}
			setTimeout(inspect, 20);
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", rejectOnce);
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				const rpcEvents = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
				if (
					!observedSwallowedFailure || code !== 0 || signal !== null || rpcEvents.length !== 1 ||
					rpcEvents[0]?.type !== "extension_error" || rpcEvents[0]?.event !== "session_start"
				) {
					fail("failed startup freshness controller did not remain safely idle");
				}
				if (
					existsSync(sentinel) || readJsonLines(providerLog).length !== priorProviderCount ||
					freshStartupAttestations(FAILED_STARTUP_CONTROLLER_NONCE).length !== 0
				) fail("stale readiness allowed work after failed startup");
				assertSanitized(stdout, "failed startup RPC");
				assertSanitized(stderr, "failed startup stderr");
				resolvePromise({
					pass: true,
					freshControllerNonceRequired: true,
					priorReadinessRejected: true,
					workSubmitted: false,
					hostFallbackExecuted: false,
				});
			} catch (error) { rejectPromise(error); }
		});
		inspect();
	});
}

async function unsafeWorkspaceRejected(config) {
	const linked = join(temporary, "workspace-link");
	const result = spawnSync("/usr/bin/ln", ["-s", workspace, linked]);
	if (result.status !== 0) fail("symlink fixture failed");
	let rejected = false;
	try {
		await executeSandboxRequest({ ...config, workspace: linked }, { operation: "probe", input: {} });
	} catch {
		rejected = true;
	}
	if (!rejected) fail("symlink workspace was accepted");
	return true;
}

function quotaAvailable() {
	const output = commandOutput("/usr/bin/findmnt", ["-T", workspace, "-no", "OPTIONS"]);
	return /(?:^|,)(?:prjquota|project)(?:,|$)/.test(output);
}

try {
	for (const path of [workspace, inbox, publishRoot, otherWorkspace, profile]) mkdirSync(path, { recursive: true, mode: 0o700 });
	writeFileSync(join(otherWorkspace, "private.txt"), "other user private\n", { mode: 0o600 });
	writeFileSync(join(inbox, "input.txt"), "inbox fixture\n", { mode: 0o400 });
	writeJson(join(profile, "auth.json"), {});
	writeJson(join(profile, "models-store.json"), {});
	copyFileSync(workerSource, stagedWorker);
	chmodSync(stagedWorker, 0o444);
	const compiler = spawnSync("/usr/bin/cc", [
		"-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", helperSource,
		"-o", compiledHelper, "-lcrypto",
	], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
	if (compiler.status !== 0) fail("secure helper compilation failed");
	chmodSync(compiledHelper, 0o555);
	for (const [label, path, expected] of [
		["extension", extension, ARTIFACT_SHA256.extension],
		["backend", backend, ARTIFACT_SHA256.backend],
		["worker", workerSource, ARTIFACT_SHA256.worker],
		["helper source", helperSource, ARTIFACT_SHA256.helperSource],
		["compiled helper", compiledHelper, ARTIFACT_SHA256.compiledHelper],
		["provider", provider, ARTIFACT_SHA256.provider],
	]) {
		if (sha256(path) !== expected) fail(`${label} input drift`);
	}

	const piExecutable = realpathSync(commandOutput("which", ["pi"]));
	const piRoot = resolve(dirname(piExecutable), "..");
	const piPackage = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
	if (
		piPackage.name !== "@earendil-works/pi-coding-agent" || piPackage.version !== PI_VERSION ||
		treeSha256(piRoot) !== PI_TREE_SHA256 ||
		treeSha256(piRoot, true) !== PI_DEPENDENCY_CLOSURE_SHA256
	) fail("Pi input drift");

	const config = baseConfiguration();
	const resources = await resourceCases(config);
	const symlinkWorkspaceRejected = await unsafeWorkspaceRejected(config);
	const initializationFailure = initializationFailureCase();
	const sequenceEvents = await runPiSequence("sandbox-sequence", [
		{ id: "catalog", type: "get_available_models" },
		{ id: "select", type: "set_model", provider: "hitch-p0-sandbox", modelId: "sandbox-image" },
		{ id: "direct", type: "bash", command: "printf direct-owned > direct.txt; printf HITCH_DIRECT_BASH_OK", _requireReady: true },
		{
			id: "turn",
			type: "prompt",
			message: "sandbox fixture",
			images: [{ type: "image", data: IMAGE_BASE64, mimeType: "image/png" }],
			_waitForSettled: true,
			_requireReady: true,
		},
		{ id: "last", type: "get_last_assistant_text" },
	]);
	const catalog = response(sequenceEvents, "catalog").data?.models ?? [];
	if (!catalog.some((model) => model.provider === "hitch-p0-sandbox" && model.id === "sandbox-image")) fail("fixture model missing");
	response(sequenceEvents, "select");
	const direct = response(sequenceEvents, "direct").data;
	if (direct?.output !== "HITCH_DIRECT_BASH_OK" || direct.exitCode !== 0) fail("direct bash did not use the backend");
	response(sequenceEvents, "turn");
	if (response(sequenceEvents, "last").data?.text !== "HITCH_P0_SANDBOX_COMPLETE") fail("tool sequence did not complete");
	const toolStarts = sequenceEvents.filter((event) => event.type === "tool_execution_start").map((event) => event.toolName);
	exactSet(toolStarts, EXPECTED_TOOLS, "model tool routing");
	if (sequenceEvents.filter((event) => event.type === "agent_settled").length !== 1) fail("agent settlement count differed");
	if (readFileSync(join(workspace, "result.txt"), "utf8") !== "beta fixture\n") fail("workspace mutations differed");
	if (readFileSync(join(workspace, "bash.txt"), "utf8") !== "sandboxed") fail("sandbox bash mutation missing");
	if (readFileSync(join(workspace, "direct.txt"), "utf8") !== "direct-owned") fail("direct bash mutation missing");
	const published = readdirSync(publishRoot).filter((name) => name.endsWith(".blob"));
	if (published.length !== 1 || readFileSync(join(publishRoot, published[0]), "utf8") !== "beta fixture\n") fail("publication snapshot differed");
	const providerCalls = readJsonLines(providerLog);
	if (providerCalls.length !== 9 || providerCalls.some((call) => call.imageSeen !== true)) fail("native image/tool provider sequence differed");
	const startupAttestations = readJsonLines(backendLog).filter((record) => record.type === "startup-attestation");
	if (startupAttestations.length !== 1 || startupAttestations[0].ready !== true) fail("startup attestation missing");
	if (startupAttestations[0].controllerNonce !== SEQUENCE_CONTROLLER_NONCE) fail("startup attestation was not controller-bound");
	exactSet(startupAttestations[0].exactTools, EXPECTED_TOOLS, "attested tools");

	const failedStartupFreshness = await failedStartupFreshnessCase();
	const cancellation = await runCancellationCase();
	if (activeSandboxUnitCount() !== 0) fail("active sandbox unit remained after Pi cancellation");
	const audits = readJsonLines(backendLog);
	if (audits.filter((record) => record.unitDigest).some((record) => record.cleanupConfirmed !== true)) fail("backend audit contained ambiguous cleanup");
	if (audits.some((record) => record.publicationCleanupConfirmed === false)) fail("publication cleanup was ambiguous");
	assertSanitized(audits, "backend audit");
	assertSanitized(providerCalls, "provider fixture log");

	const manifest = {
		schemaVersion: 1,
		type: "hitch.phase0.sandbox-evidence",
		createdAt: new Date().toISOString(),
		inputs: {
			pi: commandOutput("pi", ["--version"]),
			piPackageTreeSha256: PI_TREE_SHA256,
			piDependencyClosureSha256: PI_DEPENDENCY_CLOSURE_SHA256,
			node: process.version,
			kernel: commandOutput("uname", ["-r"]),
			bubblewrap: commandOutput("bwrap", ["--version"]),
			systemd: commandOutput("systemd-run", ["--version"]).split("\n")[0],
			extensionSha256: sha256(extension),
			backendSha256: sha256(backend),
			workerSourceSha256: sha256(workerSource),
			helperSourceSha256: sha256(helperSource),
			compiledHelperSha256: sha256(compiledHelper),
			providerFixtureSha256: sha256(provider),
			runnerSha256: sha256(fileURLToPath(import.meta.url)),
		},
		controls: {
			realCredentialsUsed: false,
			realProviderCallsMade: false,
			externalNetworkAllowed: false,
			ambientHomeUsed: false,
			gondolinEvaluated: false,
			gondolinReason: "qemu-unavailable",
		},
		cases: {
			toolAndMediaRouting: {
				pass: true,
				exactTools: EXPECTED_TOOLS,
				directRpcBashRouted: true,
				nativeImageReachedProvider: true,
				workspaceReadWrite: true,
				inboxReadOnly: true,
				publicationSnapshot: true,
				providerStreamCalls: providerCalls.length,
				agentSettled: true,
				toolSchemaDigest: startupAttestations[0].schemaDigest,
			},
			resources,
			pathSafety: {
				pass: true,
				symlinkWorkspaceRejected,
				openat2Revalidation: true,
				fdBoundMounts: true,
				reviewedWorkerSealedInMemfd: true,
			},
			cancellation,
			failClosed: {
				pass: true,
				initializationFailure,
				failedStartupFreshness,
				allBackendCleanupsConfirmed: true,
				activeUnitsAfterSuite: activeSandboxUnitCount(),
				noHostFallbackObserved: true,
			},
		},
		hostPrerequisites: {
			workspaceProjectQuotaAvailable: quotaAvailable(),
			qemuAvailable: existsSync("/usr/bin/qemu-system-x86_64"),
		},
		decision: {
			candidate: "custom-bubblewrap",
			deterministicSubgate: "pass",
			productionDisposition: quotaAvailable()
				? "candidate-ready-for-independent-review"
				: "blocked-until-production-filesystem-enables-enforceable-project-quota",
		},
		outcome: "deterministic-subgate-pass-with-host-quota-blocker",
	};
	assertSanitized(manifest, "evidence manifest");
	writeFileSync(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} finally {
	if (process.env.HITCH_KEEP_P0_TEMP === "1") process.stderr.write(`kept ${temporary}\n`);
	else rmSync(temporary, { recursive: true, force: true });
}
