import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join } from "node:path";

const MAX_PROTOCOL_OUTPUT = 1024 * 1024;
const SOURCE_COUNT_WITHOUT_PUBLISH = 4;
const activeUnits = new Set();
let invocationCounter = 0;

function fail() {
	throw new Error("sandbox-failed");
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
	return sha256Bytes(readFileSync(path));
}

function strictAbsolute(path) {
	if (
		typeof path !== "string" || !path.startsWith("/") || path === "/" ||
		path.endsWith("/") || path.includes("//") || path.includes("\0") ||
		path.split("/").some((part) => part === "." || part === "..")
	) fail();
	return path;
}

function artifact(path, expectedDigest, executable) {
	strictAbsolute(path);
	if (realpathSync(path) !== path) fail();
	const stat = lstatSync(path, { bigint: true });
	if (
		!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) ||
		(stat.mode & 0o222n) !== 0n || (executable && (stat.mode & 0o111n) === 0n) ||
		sha256File(path) !== expectedDigest
	) fail();
	return stat;
}

function directory(path) {
	strictAbsolute(path);
	if (realpathSync(path) !== path) fail();
	const stat = lstatSync(path, { bigint: true });
	if (!stat.isDirectory()) fail();
	return stat;
}

function encoded(value) {
	return Buffer.from(value, "utf8").toString("hex");
}

function sourceLine(kind, access, destination, path, stat, digest = "-") {
	return [
		kind,
		access,
		encoded(destination),
		stat.dev,
		stat.ino,
		stat.mode,
		stat.nlink,
		stat.uid,
		stat.gid,
		stat.size,
		digest,
		encoded(path),
	].join(" ");
}

function pathsOverlap(left, right) {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function configuration(input, publish) {
	if (input === null || typeof input !== "object" || Array.isArray(input)) fail();
	const workspace = strictAbsolute(input.workspace);
	const inbox = strictAbsolute(input.inbox);
	const publishRoot = strictAbsolute(input.publishRoot);
	const worker = strictAbsolute(input.worker);
	const helper = strictAbsolute(input.helper);
	const log = strictAbsolute(input.log);
	const protectedPaths = [workspace, inbox, publishRoot, worker, helper, log, "/usr"];
	for (let left = 0; left < protectedPaths.length; left++) {
		for (let right = left + 1; right < protectedPaths.length; right++) {
			if (pathsOverlap(protectedPaths[left], protectedPaths[right])) fail();
		}
	}
	const workspaceStat = directory(workspace);
	const inboxStat = directory(inbox);
	const publishStat = directory(publishRoot);
	const workerStat = artifact(worker, input.workerSha256, false);
	const helperStat = artifact(helper, input.helperSha256, true);
	const runtimeStat = directory("/usr");
	const identities = [workspaceStat, inboxStat, publishStat, workerStat, helperStat, runtimeStat]
		.map((stat) => `${stat.dev}:${stat.ino}`);
	if (new Set(identities).size !== identities.length) fail();
	const temporaryBytes = Number(input.temporaryBytes);
	const memoryBytes = Number(input.memoryBytes);
	const maximumProcesses = Number(input.maximumProcesses);
	const wallMilliseconds = Number(input.wallMilliseconds);
	if (
		!Number.isSafeInteger(temporaryBytes) || temporaryBytes < 4096 || temporaryBytes > 64 * 1024 * 1024 ||
		!Number.isSafeInteger(memoryBytes) || memoryBytes < 64 * 1024 * 1024 || memoryBytes > 1024 * 1024 * 1024 ||
		!Number.isSafeInteger(maximumProcesses) || maximumProcesses < 16 || maximumProcesses > 128 ||
		!Number.isSafeInteger(wallMilliseconds) || wallMilliseconds < 250 || wallMilliseconds > 30_000 ||
		typeof input.turnHandle !== "string" || !/^[a-f0-9]{32}$/.test(input.turnHandle) ||
		typeof input.unitPrefix !== "string" || !/^[a-f0-9]{16}$/.test(input.unitPrefix)
	) fail();
	return {
		...input,
		workspace,
		inbox,
		publishRoot,
		worker,
		helper,
		log,
		unitPrefix: input.unitPrefix,
		temporaryBytes,
		memoryBytes,
		maximumProcesses,
		wallMilliseconds,
		lines: [
			sourceLine("d", "w", "/workspace", workspace, workspaceStat),
			sourceLine("d", "r", "/inbox", inbox, inboxStat),
			sourceLine("f", "r", "/hitch-runtime/worker.mjs", worker, workerStat, input.workerSha256),
			sourceLine("f", "r", "/hitch-runtime/publish-copy", helper, helperStat, input.helperSha256),
			sourceLine("d", "r", "/usr", "/usr", runtimeStat),
			...(publish ? [sourceLine("d", "w", "/publish", publishRoot, publishStat)] : []),
		],
	};
}

function frame(config, nonce) {
	const payload = Buffer.from(
		`${nonce} ${config.lines.length} ${config.temporaryBytes}\n${config.lines.join("\n")}\n`,
		"utf8",
	);
	if (payload.length > 65536) fail();
	const header = Buffer.alloc(14);
	header.write("HITCHP0B1\n", 0, "ascii");
	header.writeUInt32BE(payload.length, 10);
	return Buffer.concat([header, payload]);
}

function environment() {
	const uid = process.getuid();
	const runtime = `/run/user/${uid}`;
	return {
		PATH: "/usr/bin:/bin",
		LANG: "C",
		LC_ALL: "C",
		XDG_RUNTIME_DIR: runtime,
		DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
	};
}

function systemctl(args, env = environment()) {
	const result = spawnSync("/usr/bin/systemctl", ["--user", ...args], {
		encoding: "utf8",
		env,
		timeout: 5000,
	});
	return { code: result.status ?? 127, stdout: result.stdout ?? "" };
}

function unitProperties(unitName) {
	const result = systemctl([
		"show", unitName,
		"--property=LoadState,ActiveState,InvocationID,ControlGroup,Description,MemoryMax,MemorySwapMax,TasksMax,RuntimeMaxUSec,CPUQuotaPerSecUSec,KillMode",
	]);
	if (result.code !== 0) fail();
	return Object.fromEntries(result.stdout.trim().split("\n").filter(Boolean).map((line) => {
		const split = line.indexOf("=");
		return [line.slice(0, split), line.slice(split + 1)];
	}));
}

function cgroupEmpty(controlGroup) {
	if (typeof controlGroup !== "string" || !controlGroup.startsWith("/")) return false;
	const root = join("/sys/fs/cgroup", controlGroup);
	if (!existsSync(root)) return true;
	function visit(path) {
		const procs = join(path, "cgroup.procs");
		if (existsSync(procs) && readFileSync(procs, "utf8").trim() !== "") return false;
		for (const name of readdirSync(path)) {
			const child = join(path, name);
			try { if (statSync(child).isDirectory() && !visit(child)) return false; } catch {}
		}
		return true;
	}
	return visit(root);
}

function systemdDurationMilliseconds(value) {
	const match = /^(\d+(?:\.\d+)?)(us|ms|s|min)$/.exec(value ?? "");
	if (!match) return Number.NaN;
	const multiplier = match[2] === "us" ? 0.001 : match[2] === "ms" ? 1 : match[2] === "s" ? 1000 : 60_000;
	return Number(match[1]) * multiplier;
}

function assertCgroupLimits(controlGroup, config) {
	const root = join("/sys/fs/cgroup", controlGroup);
	const memory = readFileSync(join(root, "memory.max"), "utf8").trim();
	const swap = readFileSync(join(root, "memory.swap.max"), "utf8").trim();
	const tasks = readFileSync(join(root, "pids.max"), "utf8").trim();
	const cpu = readFileSync(join(root, "cpu.max"), "utf8").trim().split(/\s+/).map(Number);
	if (
		memory !== String(config.memoryBytes) || swap !== "0" || tasks !== String(config.maximumProcesses) ||
		cpu.length !== 2 || !Number.isFinite(cpu[0]) || !Number.isFinite(cpu[1]) || cpu[1] <= 0 ||
		cpu[0] / cpu[1] !== 0.5
	) fail();
}

async function cleanup(unitName, controlGroup, child, expectedDescription) {
	if (!controlGroup) {
		try {
			const current = unitProperties(unitName);
			if (current.LoadState !== "not-found") {
				if (current.Description !== expectedDescription) return false;
				controlGroup = current.ControlGroup;
			}
		} catch {}
	}
	systemctl(["kill", "--kill-whom=all", "--signal=KILL", unitName]);
	systemctl(["stop", unitName]);
	child?.kill("SIGKILL");
	for (let index = 0; index < 100; index++) {
		let inactive = false;
		try {
			const properties = unitProperties(unitName);
			inactive = properties.LoadState === "not-found" || ["inactive", "failed"].includes(properties.ActiveState);
		} catch {
			inactive = true;
		}
		if (inactive && (!controlGroup || cgroupEmpty(controlGroup))) {
			activeUnits.delete(unitName);
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

function audit(config, record) {
	appendFileSync(config.log, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

function cleanupPublicationTemporary(config, request) {
	if (request?.operation !== "hitch_publish") return true;
	const artifactId = request?.input?.artifactId;
	if (typeof artifactId !== "string" || !/^[a-f0-9]{32}$/.test(artifactId)) return false;
	const temporary = join(config.publishRoot, `${artifactId}.tmp`);
	try { unlinkSync(temporary); } catch (error) {
		if (error?.code !== "ENOENT") return false;
	}
	let directoryFd = -1;
	try {
		directoryFd = openSync(config.publishRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_CLOEXEC);
		fsyncSync(directoryFd);
		return !existsSync(temporary);
	} catch {
		return false;
	} finally {
		if (directoryFd >= 0) closeSync(directoryFd);
	}
}

function responseLine(child, maximumBytes, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		let buffer = Buffer.alloc(0);
		const onAbort = () => reject(new Error("aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		const cleanupListeners = () => signal?.removeEventListener("abort", onAbort);
		child.stdout.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > maximumBytes) {
				cleanupListeners();
				reject(new Error("output-limit"));
				return;
			}
			const newline = buffer.indexOf(10);
			if (newline >= 0) {
				child.stdout.pause();
				child.stdout.removeAllListeners("data");
				cleanupListeners();
				resolve({ line: buffer.subarray(0, newline).toString("utf8"), rest: buffer.subarray(newline + 1) });
			}
		});
		child.once("error", reject);
		child.once("exit", () => reject(new Error("early-exit")));
	});
}

async function collectAfterHandoff(child, initial, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const chunks = initial.length ? [initial] : [];
		let used = initial.length;
		let stderrBytes = 0;
		const onAbort = () => reject(new Error("aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (error, value) => {
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error); else resolve(value);
		};
		child.stdout.on("data", (chunk) => {
			used += chunk.length;
			if (used > MAX_PROTOCOL_OUTPUT) return finish(new Error("output-limit"));
			chunks.push(chunk);
		});
		child.stdout.resume();
		child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
		child.once("error", () => finish(new Error("spawn-failed")));
		child.once("exit", (code, exitSignal) => finish(null, {
			code,
			signal: exitSignal,
			stdout: Buffer.concat(chunks).toString("utf8"),
			stderrWithinBound: stderrBytes <= 4096,
		}));
	});
}

export function assertSandboxBackendReady(input) {
	configuration(input, false);
	const bwrap = lstatSync("/usr/bin/bwrap", { bigint: true });
	const systemdRun = lstatSync("/usr/bin/systemd-run", { bigint: true });
	if (!bwrap.isFile() || bwrap.uid !== 0n || (bwrap.mode & 0o022n) !== 0n) fail();
	if (!systemdRun.isFile() || systemdRun.uid !== 0n || (systemdRun.mode & 0o022n) !== 0n) fail();
	return true;
}

export async function executeSandboxRequest(input, request, signal) {
	const publish = request?.operation === "hitch_publish";
	const config = configuration(input, publish);
	if (signal?.aborted) fail();
	const nonce = randomBytes(32).toString("hex");
	const unitDigest = sha256Bytes(`${config.turnHandle}:${invocationCounter++}:${nonce}`).slice(0, 24);
	const unitBase = `hitch-p0-${config.unitPrefix}-${unitDigest}`;
	const unitName = `${unitBase}.scope`;
	const description = `Hitch P0 ${nonce}`;
	const args = [
		"--user", "--scope", "--quiet", `--unit=${unitBase}`, `--description=${description}`,
		"--property=CollectMode=inactive-or-failed", "--property=KillMode=control-group",
		"--property=MemoryAccounting=yes", `--property=MemoryMax=${config.memoryBytes}`,
		"--property=MemorySwapMax=0", "--property=TasksAccounting=yes",
		`--property=TasksMax=${config.maximumProcesses}`,
		`--property=RuntimeMaxSec=${config.wallMilliseconds}ms`, "--property=CPUQuota=50%",
		"--", config.helper,
	];
	const absent = unitProperties(unitName);
	if (absent.LoadState !== "not-found") fail();
	const child = spawn("/usr/bin/systemd-run", args, {
		env: environment(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	activeUnits.add(unitName);
	let controlGroup = "";
	let outcome = "failed";
	let cleanupConfirmed = false;
	try {
		child.stdin.write(frame(config, nonce));
		const handoff = await responseLine(child, 1024, signal);
		if (!handoff.line.startsWith(`HITCH_P0_HANDOFF ${nonce} `)) fail();
		const properties = unitProperties(unitName);
		controlGroup = properties.ControlGroup;
		if (
			properties.LoadState !== "loaded" || !["active", "activating"].includes(properties.ActiveState) ||
			properties.Description !== description || properties.KillMode !== "control-group" ||
			properties.MemoryMax !== String(config.memoryBytes) || properties.MemorySwapMax !== "0" ||
			properties.TasksMax !== String(config.maximumProcesses) ||
			systemdDurationMilliseconds(properties.RuntimeMaxUSec) !== config.wallMilliseconds ||
			systemdDurationMilliseconds(properties.CPUQuotaPerSecUSec) !== 500 ||
			!properties.InvocationID || !controlGroup
		) fail();
		assertCgroupLimits(controlGroup, config);
		child.stdin.write(Buffer.from([0x47]));
		child.stdin.end(Buffer.from(JSON.stringify(request), "utf8"));
		const result = await collectAfterHandoff(child, handoff.rest, signal);
		if (!result.stderrWithinBound) fail();
		cleanupConfirmed = await cleanup(unitName, controlGroup, child, description);
		if (!cleanupConfirmed) fail();
		const lines = result.stdout.split("\n").filter(Boolean);
		if (lines.length !== 1) fail();
		const decoded = JSON.parse(lines[0]);
		if (!decoded?.ok || result.code !== 0 || result.signal !== null) fail();
		outcome = "succeeded";
		audit(config, { operation: request.operation, outcome, unitDigest, cleanupConfirmed });
		return decoded.result;
	} catch {
		cleanupConfirmed = await cleanup(unitName, controlGroup, child, description);
		const publicationCleanupConfirmed = cleanupPublicationTemporary(config, request);
		audit(config, {
			operation: request?.operation ?? "invalid",
			outcome,
			unitDigest,
			cleanupConfirmed,
			...(request?.operation === "hitch_publish" ? { publicationCleanupConfirmed } : {}),
		});
		fail();
	}
}

export function activeSandboxUnitCount() {
	return activeUnits.size;
}
