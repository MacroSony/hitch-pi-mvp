import { createHash } from "node:crypto";

function reject(reason) {
	return { accepted: false, reason, mediaEligible: false };
}

function safeIntegerId(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? String(value)
		: undefined;
}

function exactString(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 512 &&
		!/\p{Cc}/u.test(value)
		? value
		: undefined;
}

function compositeKey(...parts) {
	return parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("");
}

export function classifyTelegramUpdate(endpoint, update) {
	if (endpoint?.platform !== "telegram") return reject("endpoint-platform");
	const accountId = exactString(endpoint.accountId);
	const expectedChatId = exactString(endpoint.chatId);
	const expectedUserId = exactString(endpoint.userId);
	if (!accountId || !expectedChatId || !expectedUserId) return reject("endpoint-incomplete");
	if (update === null || typeof update !== "object" || Array.isArray(update)) return reject("update-invalid");
	const updateId = safeIntegerId(update.update_id);
	if (!updateId) return reject("update-id-unstable");
	const hasMessage = update.message !== undefined;
	const hasCallback = update.callback_query !== undefined;
	if (hasMessage === hasCallback) return reject("payload-ambiguous");

	if (hasMessage) {
		const message = update.message;
		const messageId = safeIntegerId(message?.message_id);
		const chatId = safeIntegerId(message?.chat?.id);
		const userId = safeIntegerId(message?.from?.id);
		if (!messageId) return reject("message-id-unstable");
		if (message?.chat?.type !== "private") return reject("group-or-ambiguous-chat");
		if (!chatId || !userId) return reject("identity-missing");
		if (chatId !== expectedChatId || userId !== expectedUserId) return reject("identity-mismatch");
		return {
			accepted: true,
			kind: "message",
			identityKey: compositeKey("telegram", accountId, chatId, userId),
			idempotencyKey: compositeKey("telegram", accountId, chatId, userId, updateId, messageId),
			mediaEligible: true,
		};
	}

	const callback = update.callback_query;
	const callbackId = exactString(callback?.id);
	const messageId = safeIntegerId(callback?.message?.message_id);
	const chatId = safeIntegerId(callback?.message?.chat?.id);
	const userId = safeIntegerId(callback?.from?.id);
	if (!callbackId || !messageId) return reject("callback-id-unstable");
	if (callback?.message?.chat?.type !== "private") return reject("group-or-ambiguous-chat");
	if (!chatId || !userId) return reject("identity-missing");
	if (chatId !== expectedChatId || userId !== expectedUserId) return reject("identity-mismatch");
	return {
		accepted: true,
		kind: "callback-envelope",
		identityKey: compositeKey("telegram", accountId, chatId, userId),
		idempotencyKey: compositeKey("telegram", accountId, chatId, userId, updateId, callbackId),
		mediaEligible: false,
	};
}

export function classifyWeChatMessage(endpoint, authenticatedAccountId, message) {
	if (endpoint?.platform !== "wechat") return reject("endpoint-platform");
	const accountId = exactString(endpoint.accountId);
	const expectedUserId = exactString(endpoint.userId);
	if (!accountId || !expectedUserId) return reject("endpoint-incomplete");
	if (authenticatedAccountId !== accountId) return reject("account-mismatch");
	if (message === null || typeof message !== "object" || Array.isArray(message)) return reject("message-invalid");
	if (message.message_type !== 1) return reject("not-user-message");
	if (message.group_id !== undefined && message.group_id !== "") return reject("group-message");
	const userId = exactString(message.from_user_id);
	if (!userId) return reject("identity-missing");
	if (userId !== expectedUserId) return reject("identity-mismatch");
	if (message.to_user_id !== undefined && message.to_user_id !== accountId) return reject("recipient-mismatch");
	const messageId = safeIntegerId(message.message_id);
	if (!messageId) return reject("message-id-unstable");
	return {
		accepted: true,
		kind: "message",
		identityKey: compositeKey("wechat", accountId, userId),
		idempotencyKey: compositeKey("wechat", accountId, userId, messageId),
		contextTokenBindingKey: compositeKey("wechat", accountId, userId),
		mediaEligible: true,
	};
}

function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, stable(child)]));
	}
	return value;
}

export function contentDigest(value) {
	return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export class IdempotencyLedger {
	#entries = new Map();

	admit(key, digest) {
		if (typeof key !== "string" || key.length === 0 || !/^[a-f0-9]{64}$/.test(digest)) {
			throw new Error("invalid idempotency admission");
		}
		const prior = this.#entries.get(key);
		if (prior === undefined) {
			this.#entries.set(key, digest);
			return "new";
		}
		return prior === digest ? "duplicate" : "conflict";
	}
}
