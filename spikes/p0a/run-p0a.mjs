#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const workspace = join(here, "workspace");
const profile = join(here, "fixture/profile");
const probe = join(here, "p0a-probe.ts");
const collision = join(here, "p0a-collision.ts");
const attestor = join(here, "p0a-attestor.ts");
const discoveryFixture = join(workspace, ".pi/extensions/auto-discovered.ts");
const manifestPath = join(here, "P0A-EVIDENCE.json");
const temporary = mkdtempSync(join(tmpdir(), "hitch-p0a-"));

const BUILTIN_NAMES = ["read", "write", "edit", "ls", "grep", "find", "bash"];
const EXPLICIT_COMMAND_NAMES = ["llama", "p0a"];
const PINNED_PI_VERSION = "0.84.1";
const PINNED_PI_TREE_SHA256 = "7298ead16e553a8ffc372ca6a5a17ccfd711ae0887830134255dcea08be55bba";

function fail(message) {
	throw new Error(message);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function treeSha256(root) {
	const hash = createHash("sha256");
	function visit(directory, prefix = "") {
		for (const name of readdirSync(directory).sort()) {
			if (!prefix && name === "node_modules") continue;
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
		env: minimalEnvironment(),
		timeout: 15_000,
	});
	if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function minimalEnvironment(overrides = {}) {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: temporary,
		LANG: "C.UTF-8",
		NO_COLOR: "1",
		PI_CODING_AGENT_DIR: profile,
		PI_CODING_AGENT_SESSION_DIR: join(temporary, "sessions"),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		...overrides,
	};
}

function parseRpc(stdout, name) {
	return stdout
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				fail(`${name}: non-JSON RPC stdout: ${line.slice(0, 200)}`);
			}
		});
}

function runPi(name, args, input, overrides = {}) {
	const result = spawnSync("pi", args, {
		cwd: workspace,
		encoding: "utf8",
		input: `${input.map((value) => JSON.stringify(value)).join("\n")}\n`,
		env: minimalEnvironment(overrides),
		timeout: 20_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	if (result.error) fail(`${name}: ${result.error.message}`);
	if (result.status !== 0) {
		fail(`${name}: Pi exited ${result.status}; stderr=${result.stderr.trim().slice(0, 1000)}`);
	}
	return parseRpc(result.stdout, name);
}

function response(events, id) {
	const found = events.find((event) => event?.id === id && event?.type === "response");
	if (!found) fail(`missing RPC response ${id}`);
	if (found.success !== true) fail(`RPC response ${id} failed`);
	return found;
}

function commandNames(events, id = "commands") {
	const commands = response(events, id).data?.commands;
	if (!Array.isArray(commands)) fail(`${id}: response has no command list`);
	return commands.map((command) => command.name).sort();
}

function readLog(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function toolSources(log) {
	const tools = {};
	for (const line of log.split("\n")) {
		const match = /tool:([^ ]+) source=([^ ]+) path=(.+)$/.exec(line);
		if (!match) continue;
		tools[match[1]] = { source: match[2], path: JSON.parse(match[3]) };
	}
	return tools;
}

function activeTools(log) {
	const matches = [...log.matchAll(/getActiveTools=(\[[^\n]+\])/g)];
	if (matches.length === 0) fail("probe log did not include getActiveTools");
	return JSON.parse(matches.at(-1)[1]);
}

function exactSet(actual, expected, label) {
	const left = [...actual].sort();
	const right = [...expected].sort();
	if (JSON.stringify(left) !== JSON.stringify(right)) {
		fail(`${label}: expected ${JSON.stringify(right)}, got ${JSON.stringify(left)}`);
	}
}

function explicitArgs(extensionPaths = [probe], includeTools = true) {
	return [
		"--mode", "rpc",
		"--no-session",
		"--no-extensions",
		...extensionPaths.flatMap((path) => ["--extension", path]),
		"--no-builtin-tools",
		...(includeTools ? ["--tools", BUILTIN_NAMES.join(",")] : []),
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-approve",
	];
}

function assertAllSources(tools, expected) {
	for (const name of BUILTIN_NAMES) {
		if (tools[name]?.source !== expected) fail(`tool ${name}: expected source=${expected}, got ${tools[name]?.source ?? "missing"}`);
	}
}

function explicitCase(name, options = {}) {
	const logPath = join(temporary, `${name}.log`);
	const events = runPi(
		name,
		explicitArgs(options.extensionPaths ?? [probe], options.includeTools !== false),
		[
			{ id: "commands", type: "get_commands" },
			{ id: "probe", type: "prompt", message: "/p0a" },
			{ id: "bash", type: "bash", command: "echo P0A_MUST_NOT_EXECUTE_LOCALLY" },
		],
		{
			P0A_LOG: logPath,
			P0A_BASH_OVERRIDE: "1",
			...(options.skip ? { P0A_SKIP_TOOLS: options.skip } : {}),
		},
	);
	const commands = commandNames(events);
	exactSet(commands, EXPLICIT_COMMAND_NAMES, `${name} commands`);
	const bash = response(events, "bash");
	if (bash.data?.output !== "P0A_EXTENSION_OWNED_BASH\n") fail(`${name}: direct bash was not extension-owned`);
	const log = readLog(logPath);
	const tools = toolSources(log);
	exactSet(Object.keys(tools), BUILTIN_NAMES, `${name} all tools`);
	exactSet(activeTools(log), BUILTIN_NAMES, `${name} active tools`);
	return { commands, tools };
}

function discoveryCase(name, discoveryEnabled) {
	const discoveryLog = join(temporary, `${name}-discovery.log`);
	const attestorLog = join(temporary, `${name}-attestor.log`);
	const args = [
		"--mode", "rpc",
		"--no-session",
		...(discoveryEnabled ? [] : ["--no-extensions"]),
		"--extension", attestor,
		"--no-builtin-tools",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--approve",
	];
	const events = runPi(
		name,
		args,
		[{ id: "commands", type: "get_commands" }],
		{ P0A_DISCOVER_LOG: discoveryLog, P0A_ATTEST_LOG: attestorLog },
	);
	const attestationLines = readLog(attestorLog).trim().split("\n").filter(Boolean);
	if (attestationLines.length !== 1) fail(`${name}: expected one tool attestation record`);
	const attestation = JSON.parse(attestationLines[0]);
	exactSet(attestation.allTools.map((tool) => tool.name), BUILTIN_NAMES, `${name} all tools`);
	if (!attestation.allTools.every((tool) => tool.source === "builtin")) {
		fail(`${name}: non-builtin tool appeared in discovery attestation`);
	}
	exactSet(attestation.activeTools, [], `${name} active tools`);
	return {
		commands: commandNames(events),
		discoveryLogCreated: existsSync(discoveryLog),
		exactTools: attestation.allTools.map((tool) => tool.name),
		allToolSources: "builtin",
		exactActiveTools: attestation.activeTools,
	};
}

function collisionCase(name, extensionPaths) {
	const result = spawnSync("pi", explicitArgs(extensionPaths, false), {
		cwd: workspace,
		encoding: "utf8",
		input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
		env: minimalEnvironment({ P0A_LOG: join(temporary, `${name}.log`) }),
		timeout: 20_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	if (result.error) fail(`${name}: ${result.error.message}`);
	if (result.status === 0) fail(`${name}: duplicate write registration was accepted`);
	if (!/Tool "write" conflicts with /.test(result.stderr)) {
		fail(`${name}: duplicate rejection was not attributable to write conflict: ${result.stderr.trim().slice(0, 500)}`);
	}
	if (!result.stderr.includes(probe) || !result.stderr.includes(collision)) {
		fail(`${name}: duplicate rejection did not attribute both extension paths`);
	}
	return { pass: true, collision: "write", rejectedBeforeRpc: true };
}

function runMatrix() {
	const a1 = explicitCase("a1");
	assertAllSources(a1.tools, "cli");
	for (const tool of Object.values(a1.tools)) {
		if (realpathSync(tool.path) !== realpathSync(probe)) fail(`a1: unexpected winning tool path ${tool.path}`);
	}

	const a2a = discoveryCase("a2a", false);
	exactSet(a2a.commands, ["llama"], "a2a commands");
	if (a2a.discoveryLogCreated) fail("a2a: workspace extension loaded with discovery disabled");

	const a2b = discoveryCase("a2b", true);
	exactSet(a2b.commands, ["auto-discovered", "llama"], "a2b commands");
	if (!a2b.discoveryLogCreated) fail("a2b: positive discovery control did not load workspace extension");

	const b1 = explicitCase("b1", { skip: "write" });
	if (b1.tools.write?.source !== "builtin") fail(`b1: omitted write did not fail open to builtin; got ${b1.tools.write?.source}`);
	for (const name of BUILTIN_NAMES.filter((candidate) => candidate !== "write")) {
		if (b1.tools[name]?.source !== "cli") fail(`b1: ${name} did not remain extension-owned`);
	}

	const b2 = explicitCase("b2", { includeTools: false });
	assertAllSources(b2.tools, "cli");

	const b3 = explicitCase("b3");
	assertAllSources(b3.tools, "cli");

	const c1 = collisionCase("c1", [probe, collision]);
	const c2 = collisionCase("c2", [collision, probe]);

	return {
		a1: { pass: true, explicitExtensionLoaded: true, exactCommands: EXPLICIT_COMMAND_NAMES, exactTools: BUILTIN_NAMES, exactActiveTools: BUILTIN_NAMES, allReplacementSources: "cli", allWinningPaths: "probe" },
		a2a: { pass: true, projectApproved: true, discoveryDisabled: true, exactCommands: ["llama"], exactTools: a2a.exactTools, exactActiveTools: a2a.exactActiveTools, allToolSources: a2a.allToolSources },
		a2b: { pass: true, projectApproved: true, positiveDiscoveryControl: true, exactCommands: ["auto-discovered", "llama"], exactTools: a2b.exactTools, exactActiveTools: a2b.exactActiveTools, allToolSources: a2b.allToolSources },
		b1: { pass: true, exactTools: BUILTIN_NAMES, exactActiveTools: BUILTIN_NAMES, omittedTool: "write", observedSource: "builtin" },
		b2: { pass: true, cliToolsOmitted: true, exactTools: BUILTIN_NAMES, exactActiveTools: BUILTIN_NAMES, allReplacementSources: "cli" },
		b3: { pass: true, rpcBashOutput: "extension-owned-sentinel" },
		c1: { ...c1, explicitOrder: "probe-then-collision" },
		c2: { ...c2, explicitOrder: "collision-then-probe" },
	};
}

try {
	const piExecutable = realpathSync(commandOutput("which", ["pi"]));
	const piPackageRoot = resolve(dirname(piExecutable), "..");
	const piPackage = JSON.parse(readFileSync(join(piPackageRoot, "package.json"), "utf8"));
	if (piPackage.name !== "@earendil-works/pi-coding-agent" || piPackage.version !== PINNED_PI_VERSION) {
		fail(`unexpected Pi package ${piPackage.name}@${piPackage.version}`);
	}
	const piTreeSha256 = treeSha256(piPackageRoot);
	if (piTreeSha256 !== PINNED_PI_TREE_SHA256) {
		fail(`Pi package tree digest drift: expected ${PINNED_PI_TREE_SHA256}, got ${piTreeSha256}`);
	}
	const cases = runMatrix();
	const manifest = {
		schemaVersion: 1,
		type: "hitch.phase0.p0a-evidence",
		createdAt: new Date().toISOString(),
		inputs: {
			pi: commandOutput("pi", ["--version"]),
			piPackageTreeSha256: piTreeSha256,
			node: process.version,
			npm: commandOutput("npm", ["--version"]),
			kernel: commandOutput("uname", ["-r"]),
			probeSha256: sha256(probe),
			collisionFixtureSha256: sha256(collision),
			attestorFixtureSha256: sha256(attestor),
			discoveryFixtureSha256: sha256(discoveryFixture),
			profileAuthFixtureSha256: sha256(join(profile, "auth.json")),
			profileModelsFixtureSha256: sha256(join(profile, "models-store.json")),
			runnerSha256: sha256(fileURLToPath(import.meta.url)),
		},
		controls: {
			credentialsUsed: false,
			providerCallsMade: false,
			offline: true,
			telemetry: false,
		},
		cases,
		outcome: "pass",
	};
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
