#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	statSync,
	writeFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const distRuntime = join(repository, "dist/src/pi/native-runtime.js");
const fixtureExtension = join(here, "provider-fixture.ts");
const evidencePath = join(here, "PAR1-EVIDENCE.json");
const temporary = mkdtempSync(join(tmpdir(), "hitch-par1-"));

const PI_VERSION = "0.84.1";
const PI_TREE_SHA256 =
	"7298ead16e553a8ffc372ca6a5a17ccfd711ae0887830134255dcea08be55bba";
const PI_DEPENDENCY_CLOSURE_SHA256 =
	"6d2055eaeef6823fd4b6edc062314e383fc6e233a4634a13e868a86eaebbcec4";
const STREAM_DELAY_MS = 800;

const sourceProfileEnv = process.env.HITCH_PAR1_SOURCE_PROFILE;
const realMode = process.env.HITCH_PAR1_REAL === "1";

process.umask(0o077);

function fail(message) {
	throw new Error(message);
}

function privateDirectory(path) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

function writePrivateJson(path, value) {
	privateDirectory(dirname(path));
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
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
			const relativePath = prefix ? `${prefix}/${name}` : name;
			const metadata = lstatSync(absolute);
			if (metadata.isDirectory()) {
				hash.update(`d\0${relativePath}\0`);
				visit(absolute, relativePath);
			} else if (metadata.isSymbolicLink()) {
				hash.update(`l\0${relativePath}\0${readlinkSync(absolute)}\0`);
			} else if (metadata.isFile()) {
				hash.update(`f\0${relativePath}\0`);
				hash.update(readFileSync(absolute));
				hash.update("\0");
			} else {
				fail(`unsupported profile entry type: ${absolute}`);
			}
		}
	}
	visit(root);
	return hash.digest("hex");
}

function copyProfile(source, destination) {
	privateDirectory(destination);
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);
		if (entry.isSymbolicLink()) {
			fail(`operator profile symlinks are not supported by this spike: ${sourcePath}`);
		}
		if (entry.isDirectory()) {
			copyProfile(sourcePath, destinationPath);
		} else if (entry.isFile()) {
			const metadata = statSync(sourcePath);
			writeFileSync(destinationPath, readFileSync(sourcePath), {
				mode: metadata.mode & 0o777,
			});
			chmodSync(destinationPath, 0o600);
		} else {
			fail(`unsupported profile entry: ${sourcePath}`);
		}
	}
}

function markerFile(owner) {
	return { spikeOwner: owner, createdAt: "content-free" };
}

function prepareSyntheticProfile(path) {
	privateDirectory(path);
	writePrivateJson(join(path, "auth.json"), {
		"hitch-par1": {
			type: "api_key",
			key: "HITCH_PAR1_SYNTHETIC_API_KEY",
		},
	});
	writePrivateJson(join(path, "models-store.json"), {});
}

function prepareProfile(baseProfile, path, owner) {
	copyProfile(baseProfile, path);
	// Marker file is unique per clone so the spike can prove no cross-copy.
	writePrivateJson(join(path, "spike-owner.json"), markerFile(owner));
	const modelsStorePath = join(path, "models-store.json");
	if (existsSync(modelsStorePath)) {
		const modelsStore = JSON.parse(readFileSync(modelsStorePath, "utf8"));
		modelsStore.spikeOwner = owner;
		writePrivateJson(modelsStorePath, modelsStore);
	} else {
		writePrivateJson(modelsStorePath, { spikeOwner: owner });
	}
}

function profileSnapshot(path) {
	const snapshot = {};
	function visit(directory, prefix = "") {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				visit(absolute, relativePath);
			} else if (entry.isFile()) {
				snapshot[relativePath] = sha256(absolute);
			} else {
				fail(`unsupported profile entry in snapshot: ${absolute}`);
			}
		}
	}
	visit(path);
	return snapshot;
}

function assertMarkerIsolation(leftPath, leftOwner, rightPath, rightOwner, label) {
	for (const [path, owner, otherOwner] of [
		[leftPath, leftOwner, rightOwner],
		[rightPath, rightOwner, leftOwner],
	]) {
		const markerPath = join(path, "spike-owner.json");
		if (!existsSync(markerPath))
			fail(`${label}: ${owner} profile lost its marker file`);
		const marker = JSON.parse(readFileSync(markerPath, "utf8"));
		if (marker.spikeOwner !== owner)
			fail(`${label}: ${owner} profile marker was overwritten`);
		const files = [];
		function visit(directory, prefix = "") {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const absolute = join(directory, entry.name);
				const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) visit(absolute, relativePath);
				else if (entry.isFile()) files.push({ relativePath, absolute });
			}
		}
		visit(path);
		for (const file of files) {
			const content = readFileSync(file.absolute, "utf8");
			if (content.includes(otherOwner))
				fail(`${label}: ${owner} profile contains ${otherOwner} marker data in ${file.relativePath}`);
		}
	}
}

function deferred() {
	let resolvePromise;
	let rejectPromise;
	const promise = new Promise((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function piCliPath() {
	return resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
	);
}

function baseArgs(sessionId, sessionDir, useFake) {
	const args = [
		"--mode",
		"rpc",
		"--offline",
		"--no-extensions",
		...(useFake ? ["--extension", fixtureExtension] : []),
		"--no-builtin-tools",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-approve",
		"--session-id",
		sessionId,
		"--session-dir",
		sessionDir,
	];
	return args;
}

function runController({
	name,
	profile,
	sessionDir,
	workspace,
	homeDir,
	streamLog,
	prompt,
	startGate,
	onReady,
	onError,
	useFake,
}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const sessionId = randomUUID();
		privateDirectory(sessionDir);
		privateDirectory(workspace);
		privateDirectory(homeDir);
		const environment = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: homeDir,
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
			NO_COLOR: "1",
			PI_CODING_AGENT_DIR: profile,
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			XDG_CONFIG_HOME: join(homeDir, ".config"),
			XDG_CACHE_HOME: join(homeDir, ".cache"),
			XDG_DATA_HOME: join(homeDir, ".local", "share"),
			...(useFake
				? {
						HITCH_PAR1_STREAM_LOG: streamLog,
						HITCH_PAR1_STREAM_DELAY_MS: String(STREAM_DELAY_MS),
					}
				: {}),
		};
		const child = spawn(process.execPath, [piCliPath(), ...baseArgs(sessionId, sessionDir, useFake)], {
			cwd: workspace,
			env: environment,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let lineBuffer = "";
		let nextId = 0;
		let closedResolve;
		let closedReject;
		const closed = new Promise((resolve, reject) => {
			closedResolve = resolve;
			closedReject = reject;
		});
		const pending = new Map();
		const waiters = new Set();
		const events = [];
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			lineBuffer += chunk;
			while (lineBuffer.includes("\n")) {
				const newline = lineBuffer.indexOf("\n");
				const line = lineBuffer.slice(0, newline);
				lineBuffer = lineBuffer.slice(newline + 1);
				if (!line.trim()) continue;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					fail(`${name}: non-JSON RPC stdout: ${line.slice(0, 200)}`);
				}
				events.push(event);
				if (event?.type === "response" && typeof event.id === "string") {
					const entry = pending.get(event.id);
					if (entry) {
						pending.delete(event.id);
						clearTimeout(entry.timer);
						entry.resolve(event);
					}
				}
				for (const waiter of [...waiters]) {
					if (!waiter.predicate(event)) continue;
					waiters.delete(waiter);
					clearTimeout(waiter.timer);
					waiter.resolve(event);
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			closedReject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			const detail =
				stderr.trim().length === 0
					? ""
					: `; stderr: ${stderr.trim().slice(-1200)}`;
			const error = new Error(
				`${name}: Pi closed before completion (code=${code ?? "null"}, signal=${signal ?? "null"})${detail}`,
			);
			for (const entry of pending.values()) {
				clearTimeout(entry.timer);
				entry.reject(error);
			}
			pending.clear();
			for (const waiter of waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
			waiters.clear();
			closedResolve({ code, signal, stdout, stderr });
		});

		function send(command) {
			return new Promise((resolve, reject) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					reject(new Error(`${name}: controller already closed`));
					return;
				}
				const id = `par1-${++nextId}`;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`${name}: RPC ${command.type} timed out`));
				}, 20_000);
				pending.set(id, {
					resolve: (event) => {
						clearTimeout(timer);
						resolve(event);
					},
					reject: (error) => {
						clearTimeout(timer);
						reject(error);
					},
					timer,
				});
				child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
					if (error) {
						clearTimeout(timer);
						pending.delete(id);
						reject(error);
					}
				});
			});
		}

		function waitFor(predicate, timeoutMs = 20_000) {
			return new Promise((resolve, reject) => {
				const waiter = {
					predicate,
					resolve: (event) => {
						clearTimeout(waiter.timer);
						resolve(event);
					},
					reject: (error) => {
						clearTimeout(waiter.timer);
						reject(error);
					},
					timer: setTimeout(() => {
						waiters.delete(waiter);
						reject(new Error(`${name}: Pi lifecycle event timed out`));
					}, timeoutMs),
				};
				waiters.add(waiter);
			});
		}

		async function main() {
			try {
				const catalogResponse = await send({ type: "get_available_models" });
				if (catalogResponse.success !== true)
					fail(`${name}: get_available_models failed`);
				const models = catalogResponse.data?.models;
				if (!Array.isArray(models) || models.length === 0)
					fail(`${name}: no available model`);
				const selected = useFake
					? models.find(
							(model) =>
								model.provider === "hitch-par1" &&
								model.id === "par1-text",
						)
					: models[0];
				if (!selected) fail(`${name}: fake model hitch-par1/par1-text missing`);
				const setModelResponse = await send({
					type: "set_model",
					provider: selected.provider,
					modelId: selected.id,
				});
				if (setModelResponse.success !== true)
					fail(`${name}: set_model failed`);
				onReady?.();
				await Promise.race([
					startGate,
					new Promise((_, reject) =>
						setTimeout(
							() => reject(new Error(`${name}: concurrency start gate timed out`)),
							25_000,
						),
					),
				]);
				const settled = waitFor((event) => event.type === "agent_settled");
				const promptResponse = await send({
					type: "prompt",
					message: prompt,
				});
				if (promptResponse.success !== true)
					fail(`${name}: prompt failed`);
				await settled;
				const lastResponse = await send({ type: "get_last_assistant_text" });
				const stateResponse = await send({ type: "get_state" });
				if (stateResponse.success !== true)
					fail(`${name}: get_state failed`);
				child.stdin.end();
				const result = await closed;
				if (result.code !== 0 || result.signal !== null)
					fail(`${name}: Pi did not close cleanly`);
				const lastText = lastResponse.data?.text;
				if (useFake && lastText !== "PAR1_FAKE_ASSISTANT")
					fail(`${name}: fake assistant text mismatch: ${JSON.stringify(lastText)}`);
				if (!useFake && (typeof lastText !== "string" || lastText.length === 0))
					fail(`${name}: real assistant text was empty`);
				const sessionFile = stateResponse.data?.sessionFile;
				if (typeof sessionFile !== "string" || !existsSync(sessionFile))
					fail(`${name}: session file missing after turn`);
				resolvePromise({
					pass: true,
					model: `${selected.provider}/${selected.id}`,
					lastText,
					sessionFile,
					events,
				});
			} catch (error) {
				onError?.(error);
				child.kill("SIGKILL");
				try {
					await closed;
				} catch {
					// Ignore secondary close errors.
				}
				rejectPromise(error);
			}
		}

		void main();
	});
}

async function main() {
	let validatePiProfile;
	try {
		({ validatePiProfile } = await import(pathToFileURL(distRuntime).href));
	} catch {
		fail("dist build is missing; run `npm run build` before this spike");
	}

	const sourceProfile = join(temporary, "source-profile");
	if (realMode && !sourceProfileEnv)
		fail("HITCH_PAR1_REAL=1 requires HITCH_PAR1_SOURCE_PROFILE");
	if (sourceProfileEnv) {
		if (!existsSync(sourceProfileEnv))
			fail(`HITCH_PAR1_SOURCE_PROFILE does not exist: ${sourceProfileEnv}`);
		copyProfile(sourceProfileEnv, sourceProfile);
	} else {
		prepareSyntheticProfile(sourceProfile);
	}

	const ownerTokenA = randomUUID();
	const ownerTokenB = randomUUID();
	const profileA = join(temporary, "profile-a");
	const profileB = join(temporary, "profile-b");
	prepareProfile(sourceProfile, profileA, ownerTokenA);
	prepareProfile(sourceProfile, profileB, ownerTokenB);

	validatePiProfile(profileA);
	validatePiProfile(profileB);

	const workspaceA = join(temporary, "workspace-a");
	const workspaceB = join(temporary, "workspace-b");
	const sessionsA = join(temporary, "sessions-a");
	const sessionsB = join(temporary, "sessions-b");
	const homesA = join(temporary, "home-a");
	const homesB = join(temporary, "home-b");
	const streamLogA = join(temporary, "stream-a.jsonl");
	const streamLogB = join(temporary, "stream-b.jsonl");

	const startGate = deferred();
	let readyCount = 0;
	let earlyError;
	const onReady = () => {
		readyCount += 1;
		if (readyCount === 2) startGate.resolve();
	};
	const onError = (error) => {
		earlyError ??= error;
		startGate.resolve();
	};

	const controllerA = runController({
		name: "par1-a",
		profile: profileA,
		sessionDir: sessionsA,
		workspace: workspaceA,
		homeDir: homesA,
		streamLog: streamLogA,
		prompt: "PAR1_CONCURRENT_A",
		startGate: startGate.promise,
		onReady,
		onError,
		useFake: !realMode,
	});
	const controllerB = runController({
		name: "par1-b",
		profile: profileB,
		sessionDir: sessionsB,
		workspace: workspaceB,
		homeDir: homesB,
		streamLog: streamLogB,
		prompt: "PAR1_CONCURRENT_B",
		startGate: startGate.promise,
		onReady,
		onError,
		useFake: !realMode,
	});

	const results = await Promise.all([controllerA, controllerB]);
	if (earlyError) throw earlyError;

	validatePiProfile(profileA);
	validatePiProfile(profileB);
	assertMarkerIsolation(profileA, ownerTokenA, profileB, ownerTokenB, "post-run");
	{
		const pathsA = Object.keys(profileSnapshot(profileA)).sort();
		const pathsB = Object.keys(profileSnapshot(profileB)).sort();
		if (JSON.stringify(pathsA) !== JSON.stringify(pathsB))
			fail("cloned profiles diverged in file paths after the concurrent run");
	}

	const streamA = existsSync(streamLogA)
		? readFileSync(streamLogA, "utf8").trim().split("\n").filter(Boolean)
		: [];
	const streamB = existsSync(streamLogB)
		? readFileSync(streamLogB, "utf8").trim().split("\n").filter(Boolean)
		: [];
	const startedA = streamA.length > 0 ? JSON.parse(streamA[0]).at : undefined;
	const completedA = streamA.length > 0 ? JSON.parse(streamA.at(-1)).at : undefined;
	const startedB = streamB.length > 0 ? JSON.parse(streamB[0]).at : undefined;
	const completedB = streamB.length > 0 ? JSON.parse(streamB.at(-1)).at : undefined;
	const overlapped =
		startedA !== undefined &&
		startedB !== undefined &&
		completedA !== undefined &&
		completedB !== undefined &&
		startedA <= completedB &&
		startedB <= completedA;
	if (!overlapped)
		fail("concurrent controllers did not overlap in time");

	// Pi legitimately writes settings.json and may refresh auth inside each
	// clone during a real run. Exact snapshots are therefore not required;
	// marker isolation plus identical path sets proves no cross-copy of clone
	// identity or files.

	const piPackageRoot = resolve(dirname(piCliPath()), "..");
	const piPackage = JSON.parse(
		readFileSync(join(piPackageRoot, "package.json"), "utf8"),
	);
	if (piPackage.name !== "@earendil-works/pi-coding-agent" || piPackage.version !== PI_VERSION)
		fail(`unexpected Pi package ${piPackage.name}@${piPackage.version}`);
	const piTree = treeSha256(piPackageRoot);
	if (piTree !== PI_TREE_SHA256) fail(`Pi tree digest drift: ${piTree}`);
	const piDependencyClosure = treeSha256(piPackageRoot, true);
	if (piDependencyClosure !== PI_DEPENDENCY_CLOSURE_SHA256)
		fail(`Pi dependency-closure digest drift: ${piDependencyClosure}`);

	const manifest = {
		schemaVersion: 1,
		type: "hitch.par1.concurrent-profile-evidence",
		createdAt: new Date().toISOString(),
		inputs: {
			node: process.version,
			pi: `${piPackage.name}@${piPackage.version}`,
			piPackageTreeSha256: piTree,
			piDependencyClosureSha256: piDependencyClosure,
			providerFixtureSha256: sha256(fixtureExtension),
			runnerSha256: sha256(fileURLToPath(import.meta.url)),
			sourceProfileProvided: Boolean(sourceProfileEnv),
			realProviderCallsEnabled: realMode,
		},
		controls: {
			realProviderCallsMade: realMode,
			realCredentialsCopied: Boolean(sourceProfileEnv),
			offline: true,
			telemetry: false,
			ambientHomeUsed: false,
			concurrencyBarrier: "both-controllers-ready-before-prompt",
			streamDelayMs: STREAM_DELAY_MS,
		},
		cases: {
			controllerA: {
				pass: results[0].pass,
				model: results[0].model,
				sessionFileCreated: true,
				profileValidated: true,
				overlap: overlapped,
			},
			controllerB: {
				pass: results[1].pass,
				model: results[1].model,
				sessionFileCreated: true,
				profileValidated: true,
				overlap: overlapped,
			},
			profileIsolation: {
				pass: true,
				profileAValidAfterRun: true,
				profileBValidAfterRun: true,
				markerIsolation: true,
				pathSetsIdentical: true,
			},
			concurrentOverlap: {
				pass: overlapped,
				streamAStartedAt: startedA,
				streamACompletedAt: completedA,
				streamBStartedAt: startedB,
				streamBCompletedAt: completedB,
				overlapped,
			},
		},
		decision: {
			piProfileDirectoryIsolation: "safe-for-two-independent-controllers",
			nativeRuntimeGateBypassed: "spike-spawns-two-direct-Pi-RPC-controllers",
			productionBlockersOutsidePiProfiles: [
				"NativePiRuntime cleanupSandboxUnits() still kills all hitch-p0-*.scope units globally; simply removing the promise gate is not sufficient without per-runtime sandbox-unit ownership.",
			],
			outcome: realMode
				? "opt-in-real-provider-concurrency-check-passed"
				: "deterministic-fake-provider-concurrency-passed",
		},
	};

	const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
	writeFileSync(evidencePath, manifestJson, { mode: 0o600 });
	process.stdout.write(manifestJson);
}

try {
	await main();
} finally {
	if (process.env.HITCH_PAR1_KEEP_TEMP !== "1") {
		rmSync(temporary, { recursive: true, force: true });
	} else {
		process.stderr.write(`keeping temp for debug: ${temporary}\n`);
	}
}
