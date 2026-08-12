#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	IdempotencyLedger,
	classifyTelegramUpdate,
	classifyWeChatMessage,
	contentDigest,
} from "./transport-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const legacyRepository = realpathSync(process.env.HITCH_LEGACY_REPO ?? resolve(repository, "../hitch-hub"));
const contractPath = join(here, "transport-contract.mjs");
const inventoryPath = join(here, "P0-TRANSPORT-INVENTORY.md");
const evidencePath = join(here, "P0-TRANSPORT-EVIDENCE.json");

const LEGACY_COMMIT = "f3b90e57f19d345616b94119174113e96129bf78";
const WECHAT_VERSION = "0.1.0";
const WECHAT_INTEGRITY = "sha512-/gsWGEGEsWA7C5cgfKtguCL7QPdT95I1HfHHiRcHtwQppwVfgD8aDL4m4soANp1qQDl5RgiJ7q9gh9X5cXUfqA==";
const WECHAT_TREE_SHA256 = "6205dfffd66cef090dab6981fb01b11d7db17c89c7b80c17f7206340fe726302";
const CONTRACT_SHA256 = "2409b50d24c6cea51bd92efc1e67b66673b2a5b62e74c4250b4d848936a4576a";
const INVENTORY_SHA256 = "ebb8224d5d3e7d6115351d14ba25ccc50f901a315328fb441674ec61c5dfcc2c";
const LEGACY_FILES = Object.freeze({
	"src/channels/telegram.ts": "b73c636b5b9dabb4cfe2644dd9c82d54b85d6b73456b24e7e86394b5f922ecc1",
	"src/channels/wechat.ts": "0598d98f13140e422f464a13e94abe3b80899d63620b17ed7f564b842a7e3167",
	"src/channels/types.ts": "d75e36da4ad650370b7434c1e1166f12409d542b76b338ebf09c0d38bffaf59b",
	"src/channels/multi.ts": "b25b180a9185693c3347757dea41942c1a5125f639a73700e71819486e68a198",
	"src/security/authorization.ts": "6e7a0b6a98c2f5be86b1338c0595ae8072b36c9810da537df1f3a5534eae775b",
	"src/core/media-cache.ts": "b72c08b0dbb6bde4b521cca89e0479013565fd1a9149f331731c1152d357d73f",
	"src/core/hub.ts": "136d4e58c777aa4c06c75d92e4c48184d3f3797ed722784c3f4140e83ad5647f",
	"src/config/schema.ts": "d05b91c6fcf80d2f3135b22a1365caccf79937eba861601dcbf25f51023f0296",
	"src/config/load-config.ts": "7d486ba7db0395761e69a7501d1c517687f9ccf80d512a8cb853067e07484e16",
	"package-lock.json": "4355a83fc2ee314bd3666693e98ddaa815e4c40e85e27a37fd2d08e075afa263",
});
const WECHAT_FILES = Object.freeze({
	"package.json": "d7b3ba4fa2b2ff1677c57db5a800a3874154e10c055175d38f3a9156cd7e4455",
	"dist/index.mjs": "79d9f9ccf5e6c35254fc4c01355bd913e63c412954f47a9bd7a3cc5538350eda",
	"dist/index.d.mts": "620a8b982a08550d3bdc133b31b657a83c0deb0b9b0a8243faf6a6a5386ef669",
	"README.md": "0c2518fdeb2126b2d20e47e8bba4012b0250cf18265442591bfa0d39a975a657",
});

function fail(message) {
	throw new Error(message);
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function sha256(path) {
	return sha256Bytes(readFileSync(path));
}

function treeSha256(root) {
	const hash = createHash("sha256");
	function visit(directory, prefix = "") {
		for (const name of readdirSync(directory).sort()) {
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

function git(args) {
	const result = spawnSync("git", ["-C", legacyRepository, ...args], {
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
		timeout: 10_000,
	});
	if (result.status !== 0) fail("legacy git inspection failed");
	return result.stdout.trim();
}

function assertIncludes(source, snippets, label) {
	for (const snippet of snippets) {
		if (!source.includes(snippet)) fail(`${label} inventory drift`);
	}
}

function reasonCounts(results) {
	const counts = {};
	for (const result of results) {
		if (!result.accepted) counts[result.reason] = (counts[result.reason] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function lengthKey(...parts) {
	return parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("");
}

function runTelegramCases() {
	const endpoint = { platform: "telegram", accountId: "bot-fixture", chatId: "1001", userId: "1001" };
	const message = {
		update_id: 77,
		message: {
			message_id: 9,
			chat: { id: 1001, type: "private" },
			from: { id: 1001 },
			text: "content cannot select identity",
			document: { file_name: "../../identity-1002", file_id: "fixture" },
		},
	};
	const callback = {
		update_id: 78,
		callback_query: {
			id: "callback-fixture",
			data: "identity=1002",
			from: { id: 1001 },
			message: { message_id: 9, chat: { id: 1001, type: "private" } },
		},
	};
	const cases = [
		[message, true],
		[callback, true],
		[{ ...message, update_id: undefined }, false],
		[{ ...message, message: { ...message.message, message_id: undefined } }, false],
		[{ ...message, message: { ...message.message, chat: { id: 1001, type: "group" } } }, false],
		[{ ...message, message: { ...message.message, chat: { id: 1001 } } }, false],
		[{ ...message, message: { ...message.message, from: undefined } }, false],
		[{ ...message, message: { ...message.message, from: { id: 1002 } } }, false],
		[{ ...message, message: { ...message.message, chat: { id: 1002, type: "private" } } }, false],
		[{ ...message, callback_query: callback.callback_query }, false],
		[{ ...callback, callback_query: { ...callback.callback_query, from: undefined } }, false],
		[{ ...callback, callback_query: { ...callback.callback_query, message: { ...callback.callback_query.message, chat: { id: 1001, type: "group" } } } }, false],
	];
	const results = cases.map(([input, expected]) => {
		const result = classifyTelegramUpdate(endpoint, input);
		if (result.accepted !== expected || (!expected && result.mediaEligible !== false)) fail("Telegram admission case failed");
		return result;
	});
	if (results[0]?.identityKey !== results[1]?.identityKey || results[0]?.mediaEligible !== true || results[1]?.mediaEligible !== false) {
		fail("Telegram content/interaction separation failed");
	}
	return { endpoint, message, results };
}

function runWeChatCases() {
	const endpoint = { platform: "wechat", accountId: "wx-account", userId: "wx-peer" };
	const message = {
		message_type: 1,
		message_id: 91,
		from_user_id: "wx-peer",
		to_user_id: "wx-account",
		group_id: "",
		context_token: "content-token-cannot-select-identity",
		item_list: [{ file_item: { file_name: "../../wx-other-peer" } }],
	};
	const cases = [
		["wx-account", message, true],
		["wx-account", { ...message, group_id: undefined }, true],
		["wrong-account", message, false],
		["wx-account", { ...message, group_id: "group-1" }, false],
		["wx-account", { ...message, from_user_id: undefined }, false],
		["wx-account", { ...message, from_user_id: "wx-other" }, false],
		["wx-account", { ...message, to_user_id: "wrong-account" }, false],
		["wx-account", { ...message, message_id: undefined, seq: 100 }, false],
		["wx-account", { ...message, message_type: 2 }, false],
	];
	const results = cases.map(([authenticatedAccount, input, expected]) => {
		const result = classifyWeChatMessage(endpoint, authenticatedAccount, input);
		if (result.accepted !== expected || (!expected && result.mediaEligible !== false)) fail("WeChat admission case failed");
		return result;
	});
	if (
		results[0]?.identityKey !== results[1]?.identityKey ||
		results[0]?.contextTokenBindingKey !== lengthKey("wechat", endpoint.accountId, endpoint.userId)
	) fail("WeChat account/peer token binding failed");
	return { endpoint, message, results };
}

if (git(["rev-parse", "HEAD"]) !== LEGACY_COMMIT) fail("legacy commit drift");
if (sha256(contractPath) !== CONTRACT_SHA256 || sha256(inventoryPath) !== INVENTORY_SHA256) fail("transport evidence input drift");
for (const [relative, expected] of Object.entries(LEGACY_FILES)) {
	const path = join(legacyRepository, relative);
	if (sha256(path) !== expected) fail(`legacy source drift: ${relative}`);
	if (sha256Bytes(git(["show", `HEAD:${relative}`])) !== expected) {
		// git strips the final newline through stdout.trim(); hash the raw file via
		// diff below instead. This branch only rejects an unexpected exact match.
		const diff = spawnSync("git", ["-C", legacyRepository, "diff", "--quiet", "HEAD", "--", relative]);
		if (diff.status !== 0) fail(`selected legacy source is dirty: ${relative}`);
	}
}

const wechatRoot = join(legacyRepository, "node_modules/wechat-ilink-client");
for (const [relative, expected] of Object.entries(WECHAT_FILES)) {
	if (sha256(join(wechatRoot, relative)) !== expected) fail(`WeChat package drift: ${relative}`);
}
const wechatPackage = JSON.parse(readFileSync(join(wechatRoot, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(legacyRepository, "package-lock.json"), "utf8"));
const lockWechat = lock.packages?.["node_modules/wechat-ilink-client"];
if (
	wechatPackage.name !== "wechat-ilink-client" || wechatPackage.version !== WECHAT_VERSION ||
	lockWechat?.version !== WECHAT_VERSION || lockWechat?.integrity !== WECHAT_INTEGRITY ||
	treeSha256(wechatRoot) !== WECHAT_TREE_SHA256
) fail("WeChat package input drift");

const telegramSource = readFileSync(join(legacyRepository, "src/channels/telegram.ts"), "utf8");
const wechatSource = readFileSync(join(legacyRepository, "src/channels/wechat.ts"), "utf8");
const hubSource = readFileSync(join(legacyRepository, "src/core/hub.ts"), "utf8");
const mediaSource = readFileSync(join(legacyRepository, "src/core/media-cache.ts"), "utf8");
const multiSource = readFileSync(join(legacyRepository, "src/channels/multi.ts"), "utf8");
const wechatRuntime = readFileSync(join(wechatRoot, "dist/index.mjs"), "utf8");
assertIncludes(telegramSource, [
	"private updateOffset = 0",
	"chat: { id: number | string }",
	"id: String(message.message_id)",
	"data: Buffer.from(await downloadResponse.arrayBuffer())",
	"const data = await readFile(artifact.path)",
], "Telegram");
assertIncludes(wechatSource, [
	"return message.group_id || message.from_user_id",
	"id: String(message.message_id ?? message.seq ?? Date.now())",
	"private readonly contextTokens = new Map<string, string>()",
	"writeFileSync(filePath, JSON.stringify(value, null, 2), \"utf8\")",
	"void this.enqueueMessage(message).catch",
], "WeChat");
assertIncludes(mediaSource, [
	"path.join(dataDir, \"media\", \"inbound\")",
	"`${sha256}${extension}`",
], "media cache");
assertIncludes(multiSource, ["private readonly values: T[] = []"], "multi-channel queue");
assertIncludes(hubSource, [
	"if (this.shouldHandleInBackground(event))",
	"const task = this.handleEvent(event).catch",
], "legacy intake");
assertIncludes(wechatRuntime, [
	"if (opts.saveSyncBuf) await opts.saveSyncBuf(getUpdatesBuf)",
	"for (const msg of msgs) await callbacks.onMessage(msg)",
	"return Buffer.from(await res.arrayBuffer())",
	"this.emit(\"message\", msg)",
], "WeChat runtime");
if (
	wechatRuntime.indexOf("if (opts.saveSyncBuf) await opts.saveSyncBuf(getUpdatesBuf)") >
	wechatRuntime.indexOf("for (const msg of msgs) await callbacks.onMessage(msg)")
) fail("WeChat cursor ordering finding drift");

const telegram = runTelegramCases();
const wechat = runWeChatCases();
const ledger = new IdempotencyLedger();
const firstDigest = contentDigest(telegram.message);
const conflictDigest = contentDigest({ ...telegram.message, message: { ...telegram.message.message, text: "different" } });
const firstKey = telegram.results[0].idempotencyKey;
if (
	ledger.admit(firstKey, firstDigest) !== "new" ||
	ledger.admit(firstKey, firstDigest) !== "duplicate" ||
	ledger.admit(firstKey, conflictDigest) !== "conflict"
) fail("idempotency same-key behavior failed");
const secondEndpoint = { platform: "telegram", accountId: "bot-fixture", chatId: "2002", userId: "2002" };
const secondUpdate = {
	...telegram.message,
	message: { ...telegram.message.message, chat: { id: 2002, type: "private" }, from: { id: 2002 } },
};
const secondAdmission = classifyTelegramUpdate(secondEndpoint, secondUpdate);
if (!secondAdmission.accepted || ledger.admit(secondAdmission.idempotencyKey, firstDigest) !== "new") {
	fail("endpoint-namespaced idempotency failed");
}
const delimiterCollisionLeft = classifyWeChatMessage(
	{ platform: "wechat", accountId: "a\0b", userId: "c" },
	"a\0b",
	{ message_type: 1, message_id: 91, from_user_id: "c", to_user_id: "a\0b", group_id: "" },
);
const delimiterCollisionRight = classifyWeChatMessage(
	{ platform: "wechat", accountId: "a", userId: "b\0c" },
	"a",
	{ message_type: 1, message_id: 91, from_user_id: "b\0c", to_user_id: "a", group_id: "" },
);
if (delimiterCollisionLeft.accepted || delimiterCollisionRight.accepted) {
	fail("control-character identity collision was admitted");
}
const structuredKeyLeft = lengthKey("wechat", "a:b", "c");
const structuredKeyRight = lengthKey("wechat", "a", "b:c");
if (structuredKeyLeft === structuredKeyRight) fail("length-prefixed identity encoding collided");

const telegramRejected = telegram.results.filter((result) => !result.accepted);
const wechatRejected = wechat.results.filter((result) => !result.accepted);
const manifest = {
	schemaVersion: 1,
	type: "hitch.phase0.transport-inventory-evidence",
	createdAt: new Date().toISOString(),
	inputs: {
		node: process.version,
		legacyCommit: LEGACY_COMMIT,
		selectedLegacyFilesSha256: LEGACY_FILES,
		wechatClient: `wechat-ilink-client@${WECHAT_VERSION}`,
		wechatClientIntegrity: WECHAT_INTEGRITY,
		wechatClientTreeSha256: WECHAT_TREE_SHA256,
		contractSha256: CONTRACT_SHA256,
		inventorySha256: INVENTORY_SHA256,
		runnerSha256: sha256(fileURLToPath(import.meta.url)),
	},
	controls: {
		realCredentialsUsed: false,
		realChannelCallsMade: false,
		networkCallsMade: false,
		messageContentRecorded: false,
		selectedLegacyFilesMatchCommit: true,
	},
	legacyFindings: {
		telegramPrivateChatTypeAbsent: true,
		telegramCursorMemoryOnly: true,
		telegramBackgroundHandlingCanAdvancePollingBeforeAdmission: true,
		telegramMediaBufferedBeforeActualBound: true,
		telegramOutboundLivePathBuffered: true,
		wechatGroupPreferredAsChatIdentity: true,
		wechatUnstableWallClockIdFallback: true,
		wechatCursorSavedBeforeMessageHandling: true,
		wechatEventEmitterDoesNotAwaitAdapterAdmission: true,
		wechatStateWritesNotCrashAtomic: true,
		wechatMediaBufferedBeforeActualBound: true,
		contextTokenNotAccountPeerBound: true,
		crossPrincipalMediaDeduplicationPresent: true,
		multiChannelQueueUnbounded: true,
	},
	cases: {
		telegram: {
			pass: true,
			total: telegram.results.length,
			accepted: telegram.results.length - telegramRejected.length,
			rejected: telegramRejected.length,
			rejectionReasons: reasonCounts(telegram.results),
			privateTupleRequiredBeforeMedia: true,
			callbackContentNotIdentity: true,
		},
		wechat: {
			pass: true,
			total: wechat.results.length,
			accepted: wechat.results.length - wechatRejected.length,
			rejected: wechatRejected.length,
			rejectionReasons: reasonCounts(wechat.results),
			privateAccountPeerRequiredBeforeMedia: true,
			contextTokenBoundToAccountPeer: true,
		},
		idempotency: {
			pass: true,
			newThenDuplicate: true,
			sameKeyDifferentDigestConflict: true,
			endpointNamespaceSeparatesSameNumericIds: true,
			controlCharacterIdentifiersRejected: true,
			lengthPrefixedCompositeKeysUnambiguous: true,
		},
	},
	decision: {
		telegramLegacyAdapter: "reference-only-rebuild-around-durable-intake",
		wechatLegacyAdapter: "reference-only-do-not-use-high-level-monitor",
		wechatClient: "pinned-candidate-for-raw-api-live-inventory-only",
		productionTransportSelected: false,
	},
	outcome: "deterministic-inventory-pass-live-channel-evidence-deferred",
};

const manifestText = JSON.stringify(manifest);
if (manifestText.includes(legacyRepository) || manifestText.includes("content-token-cannot-select-identity")) {
	fail("transport evidence was not content-free");
}
writeFileSync(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
