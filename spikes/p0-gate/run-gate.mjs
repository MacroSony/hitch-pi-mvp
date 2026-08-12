#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const profilePackages = "/home/hitch/.pi/agent/npm";
const evidencePath = join(here, "P0-GATE-EVIDENCE.json");
const packageLock = join(profilePackages, "package-lock.json");
const PACKAGE_LOCK_SHA256 = "75e860aac1cc09cad3087acc39e2f0fe34a05cf91e416761a4f2c3be1f9f3c20";
const checkpoints = Object.freeze({
	p0a: {
		path: "spikes/p0a/run-p0a.mjs", runnerSha256: "ce4e94ea52d7bf0153a520c59b0d35d61ba5ddf99e84c08e70623257f290c112",
		outcome: "pass", normalizedManifestSha256: "d1f531b5470bfc5802695333c9ffeab37e38dfd90ae53e810101bdc8fc636ef1",
		cases: ["a1", "a2a", "a2b", "b1", "b2", "b3", "c1", "c2"],
	},
	runtime: {
		path: "spikes/p0-runtime/run-runtime.mjs", runnerSha256: "7d587e1fba077d828672a14f7298b7b208afd03c18eed85f86cbc4b697dfd23a",
		outcome: "deterministic-subgate-pass-with-explicit-final-blocker", normalizedManifestSha256: "508417b69ba4d327c7dfa4424c503d875c41b468f34e65ef89abf37cc7f9ba28",
		cases: ["authWriteCrash", "concurrentSessionOpen", "modelAndSession", "oauthConcurrencyFailure", "oauthConcurrencySuccess", "oauthModelRpc", "preFlushTranscript", "retrySettlement"],
	},
	sandbox: {
		path: "spikes/p0-sandbox/run-sandbox.mjs", runnerSha256: "531cf3054f2b3e8dc918e5425721d59a1b59a36e47c3144c6b61ce215bae3362",
		outcome: "deterministic-subgate-pass-with-host-quota-blocker", normalizedManifestSha256: "094dbfcf8bc1d2e76e3f020e3a6f7fd428388cdaf05fee946284bb309e05a980",
		cases: ["cancellation", "failClosed", "pathSafety", "resources", "toolAndMediaRouting"],
	},
	transports: {
		path: "spikes/p0-transports/run-transports.mjs", runnerSha256: "097559862d79c2c6b8fc688dee36d8d79ffc828c415d7ba15490a46673636349",
		outcome: "deterministic-inventory-pass-live-channel-evidence-deferred", normalizedManifestSha256: "13ffea9b59209f00b1e971da3ecd66feaeefcaf4ab8489fbfedb7cfda3676687",
		cases: ["idempotency", "telegram", "wechat"],
	},
});
const packages = Object.freeze({
	forge: {
		name: "@zihanw/pi-forge", version: "0.4.0",
		integrity: "sha512-/B8DBXtqFLIl+Llrr1HJRYUDd2cd4jDt6CsJdBC8kCxn9Kh6Wes9AUpT+b6Cl5NB9oSMtaL0YhYitvfyUk00lQ==",
		tree: "4e3eb7894ea12b357f2be7b15929ad9b71f0d64f7e84d9b4e1a8ba075b32ef8d",
		entry: "dist/index.js", entrySha256: "4ff562bb8c580f4765def12d1bd7b05bdb6e7e1249b588c0ae1c936484cee09b",
	},
	paint: {
		name: "pi-comfyui-paint", version: "0.3.0",
		integrity: "sha512-6LWaOObIXWvVu49Ycz/UUb8Dd/LgPoh6gYSiwRUPNhhRUvEDuePlnC4RjBElLIkdbLfcEvCTMKGQANds8dA/Iw==",
		tree: "023684bd2cdaf9d18d2ca405ff8767d2d8fa473dd8981fd2bec7d9c4074ffec6",
		entry: "src/index.ts", entrySha256: "54a485be3de20778822cbd3744c081413b4da58662fd70b58d04586242fd7702",
	},
	volcengine: {
		name: "pi-volcengine-provider", version: "0.1.2",
		integrity: "sha512-Cv5ZArW9Yr5su6dEvuyK3YCoLVL7nCg5FK8abCquKRpU57PnZs2+9u9hWeOZtxBMMtNZU4wGFdh59iyaelOxQA==",
		tree: "9dfa09264530ff487eee87b1a920706cd8fce9b4639c93b36304bdf83eb288e1",
		entry: "index.ts", entrySha256: "966ede67829be738e507be7754d66d4067260628b66cab2ff7fc2a841266a6ac",
	},
});

function fail(message) { throw new Error(message); }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function sha256Bytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function treeSha256(root) {
	const hash = createHash("sha256");
	function visit(directory, prefix = "") {
		for (const name of readdirSync(directory).sort()) {
			const absolute = join(directory, name);
			const relative = prefix ? `${prefix}/${name}` : name;
			const stat = lstatSync(absolute);
			if (stat.isDirectory()) { hash.update(`d\0${relative}\0`); visit(absolute, relative); }
			else if (stat.isSymbolicLink()) hash.update(`l\0${relative}\0${readlinkSync(absolute)}\0`);
			else if (stat.isFile()) { hash.update(`f\0${relative}\0`); hash.update(readFileSync(absolute)); hash.update("\0"); }
		}
	}
	visit(root);
	return hash.digest("hex");
}
function requireText(path, snippets) {
	const text = readFileSync(path, "utf8");
	for (const snippet of snippets) if (!text.includes(snippet)) fail("operator extension finding drift");
}
function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, stable(child)]));
	}
	return value;
}
function normalizedCheckpointDigest(name, manifest) {
	const normalized = structuredClone(manifest);
	delete normalized.createdAt;
	if (name === "runtime") normalized.cases.modelAndSession.sessionFile = "<generated-session>.jsonl";
	return sha256Bytes(JSON.stringify(stable(normalized)));
}
function runnerMatches(relative, expectedDigest, bytes = readFileSync(join(repository, relative))) {
	return sha256Bytes(bytes) === expectedDigest;
}
function run(name, checkpoint) {
	if (!runnerMatches(checkpoint.path, checkpoint.runnerSha256)) fail(`${name} runner drift`);
	const result = spawnSync(process.execPath, [join(repository, checkpoint.path)], {
		cwd: repository, encoding: "utf8", timeout: 120_000,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/home/hitch", LANG: "C.UTF-8", NO_COLOR: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" },
	});
	if (result.status !== 0) fail(`${checkpoint.path} failed`);
	const manifest = JSON.parse(result.stdout);
	const caseNames = Object.keys(manifest.cases ?? {}).sort();
	if (
		manifest.schemaVersion !== 1 || manifest.outcome !== checkpoint.outcome ||
		JSON.stringify(caseNames) !== JSON.stringify(checkpoint.cases) ||
		caseNames.some((caseName) => manifest.cases[caseName]?.pass !== true) ||
		normalizedCheckpointDigest(name, manifest) !== checkpoint.normalizedManifestSha256
	) fail(`${name} checkpoint evidence drift`);
	return manifest;
}

if (realpathSync(packageLock) !== packageLock || sha256(packageLock) !== PACKAGE_LOCK_SHA256) fail("operator package lock drift");
const lock = JSON.parse(readFileSync(packageLock, "utf8"));
for (const candidate of Object.values(packages)) {
	const root = join(profilePackages, "node_modules", candidate.name);
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const lockEntry = lock.packages?.[`node_modules/${candidate.name}`];
	if (
		packageJson.name !== candidate.name || packageJson.version !== candidate.version ||
		lockEntry?.version !== candidate.version || lockEntry?.integrity !== candidate.integrity ||
		treeSha256(root) !== candidate.tree || sha256(join(root, candidate.entry)) !== candidate.entrySha256
	) fail("operator package drift");
}

const forgeRoot = join(profilePackages, "node_modules", packages.forge.name);
const paintRoot = join(profilePackages, "node_modules", packages.paint.name);
const volcengineRoot = join(profilePackages, "node_modules", packages.volcengine.name);
requireText(join(forgeRoot, "dist/index.js"), [
	"registerPayloadCommands(pi, state)", "registerForgeSubagentTool", "createWebEditorRuntime", "registerForgeSubagentCommand",
]);
requireText(join(forgeRoot, "dist/forge-config.js"), ["join(ctx.cwd, \".pi\", \"forge\", \"config.json\")", "globalForgeDir()"]);
requireText(join(forgeRoot, "dist/payload-command.js"), ["registerCommand(\"intercept\"", "registerCommand(\"payload\"", "before_provider_request"]);
requireText(join(paintRoot, "src/index.ts"), ["createInterruptTool(config)", "createSearchDanbooruTagsTool(config)", "setInterval"]);
requireText(join(paintRoot, "src/config.ts"), ["path.join(os.homedir()", "path.join(cwd, \".pi\"", "projectWorkflowDir"]);
requireText(join(volcengineRoot, "index.ts"), ["pi.registerProvider", "apiKey: \"$VOLCENGINE_API_KEY\""]);

const fakeOutcomeOnly = Buffer.from(`process.stdout.write(JSON.stringify({outcome:${JSON.stringify(checkpoints.p0a.outcome)}}))`);
if (runnerMatches(checkpoints.p0a.path, checkpoints.p0a.runnerSha256, fakeOutcomeOnly)) fail("outcome-only fake was accepted");
const results = Object.fromEntries(Object.entries(checkpoints).map(([name, checkpoint]) => [name, run(name, checkpoint)]));

const phase0Blockers = [
	"pi-auth-writer-not-crash-atomic",
	"production-workspace-project-quota-unavailable",
	"forge-hitch-service-mode-unavailable",
	"comfyui-paint-hitch-service-mode-unavailable",
	"operator-profile-and-real-api-key-oauth-smoke-unrun",
];
const manifest = {
	schemaVersion: 1,
	type: "hitch.phase0.consolidated-gate-evidence",
	createdAt: new Date().toISOString(),
	inputs: {
		node: process.version,
		operatorPackageLockSha256: PACKAGE_LOCK_SHA256,
		operatorPackages: Object.fromEntries(Object.entries(packages).map(([key, value]) => [key, {
			name: value.name, version: value.version, integrity: value.integrity,
			installedTreeSha256: value.tree, entrySha256: value.entrySha256,
		}])),
		runnerSha256: sha256(fileURLToPath(import.meta.url)),
		acceptedCheckpoints: Object.fromEntries(Object.entries(checkpoints).map(([name, checkpoint]) => [name, {
			runnerSha256: checkpoint.runnerSha256,
			normalizedManifestSha256: checkpoint.normalizedManifestSha256,
		}])),
	},
	controls: { realCredentialsUsed: false, realProviderCallsMade: false, realChannelCallsMade: false, externalNetworkUsed: false },
	checkpointResults: Object.fromEntries(Object.entries(results).map(([name, result]) => [name, result.outcome])),
	checkpointAttestation: { exactRunnerDigestsVerified: true, fullCaseSetsPassed: true, normalizedManifestsVerified: true, outcomeOnlyFakeRejected: true },
	operatorExtensions: {
		forge: { installed: true, serviceModePresent: false, disposition: "excluded-from-mvp-manifest" },
		comfyuiPaint: { installed: true, serviceModePresent: false, disposition: "excluded-from-mvp-manifest" },
		volcengineProvider: { installed: true, providerOnly: true, disposition: "inventory-only-pending-operator-profile-and-live-smoke" },
	},
	phase0Blockers,
	deferredFinalAcceptance: ["live-telegram-wechat-media-acceptance-unrun", "gondolin-unevaluated-qemu-unavailable"],
	decision: { phase0ReleaseGate: "blocked", phase1Authorized: false },
	outcome: "blocked",
};
writeFileSync(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
