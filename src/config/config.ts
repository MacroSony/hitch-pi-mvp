import { readFileSync, statSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

const MAX_CONFIG_BYTES = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

export interface TelegramAccountConfig {
  readonly id: string;
  readonly botTokenEnv: string;
}

export interface WeChatAccountConfig {
  readonly id: string;
  readonly stateDir: string;
}

export interface TelegramEndpointConfig {
  readonly account: string;
  readonly userId: string;
  readonly privateChatId: string;
}

export interface WeChatEndpointConfig {
  readonly account: string;
  readonly userId: string;
}

export interface UserConfig {
  readonly id: string;
  readonly workspace: string;
  readonly telegram?: TelegramEndpointConfig;
  readonly wechat?: WeChatEndpointConfig;
}

export type MediaMode = "always-trigger" | "text-trigger";

export interface AppConfig {
  readonly schemaVersion: 1;
  readonly dataRoot: string;
  readonly piProfileDir: string;
  readonly minimumFreeBytes: number;
  readonly mediaMode: MediaMode;
  readonly telegramAccounts: readonly TelegramAccountConfig[];
  readonly wechatAccounts: readonly WeChatAccountConfig[];
  readonly users: readonly UserConfig[];
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function fail(path: string, message: string): never {
  throw new ConfigError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      fail(`${path}.${key}`, "required field is missing");
  }
}

function stringValue(
  value: unknown,
  path: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string" || value.length === 0)
    fail(path, "expected a non-empty string");
  if (Buffer.byteLength(value, "utf8") > maximumBytes)
    fail(path, `must be at most ${maximumBytes} UTF-8 bytes`);
  return value;
}

function identifier(value: unknown, path: string): string {
  const parsed = stringValue(value, path, 64);
  if (!ID_PATTERN.test(parsed))
    fail(path, "contains unsupported identifier characters");
  return parsed;
}

function remoteIdentifier(value: unknown, path: string): string {
  const parsed = stringValue(value, path, 128);
  if (CONTROL_PATTERN.test(parsed)) fail(path, "contains control characters");
  return parsed;
}

function absolutePath(value: unknown, path: string): string {
  const parsed = stringValue(value, path, 4096);
  if (!isAbsolute(parsed) || parsed === "/" || normalize(parsed) !== parsed) {
    fail(path, "must be a normalized absolute path other than /");
  }
  return parsed;
}

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length)
    fail(path, "contains a duplicate value");
}

function parseTelegramAccount(
  value: unknown,
  index: number,
): TelegramAccountConfig {
  const path = `config.telegramAccounts[${index}]`;
  const input = record(value, path);
  exactKeys(input, ["id", "botTokenEnv"], [], path);
  const botTokenEnv = stringValue(
    input.botTokenEnv,
    `${path}.botTokenEnv`,
    128,
  );
  if (!ENV_PATTERN.test(botTokenEnv))
    fail(
      `${path}.botTokenEnv`,
      "must be an uppercase environment variable name",
    );
  return { id: identifier(input.id, `${path}.id`), botTokenEnv };
}

function parseWeChatAccount(
  value: unknown,
  index: number,
): WeChatAccountConfig {
  const path = `config.wechatAccounts[${index}]`;
  const input = record(value, path);
  exactKeys(input, ["id", "stateDir"], [], path);
  return {
    id: identifier(input.id, `${path}.id`),
    stateDir: absolutePath(input.stateDir, `${path}.stateDir`),
  };
}

function parseTelegramEndpoint(
  value: unknown,
  path: string,
): TelegramEndpointConfig {
  const input = record(value, path);
  exactKeys(input, ["account", "userId", "privateChatId"], [], path);
  return {
    account: identifier(input.account, `${path}.account`),
    userId: remoteIdentifier(input.userId, `${path}.userId`),
    privateChatId: remoteIdentifier(
      input.privateChatId,
      `${path}.privateChatId`,
    ),
  };
}

function parseWeChatEndpoint(
  value: unknown,
  path: string,
): WeChatEndpointConfig {
  const input = record(value, path);
  exactKeys(input, ["account", "userId"], [], path);
  return {
    account: identifier(input.account, `${path}.account`),
    userId: remoteIdentifier(input.userId, `${path}.userId`),
  };
}

function parseUser(value: unknown, index: number): UserConfig {
  const path = `config.users[${index}]`;
  const input = record(value, path);
  exactKeys(input, ["id", "workspace"], ["telegram", "wechat"], path);
  const telegram = Object.hasOwn(input, "telegram")
    ? parseTelegramEndpoint(input.telegram, `${path}.telegram`)
    : undefined;
  const wechat = Object.hasOwn(input, "wechat")
    ? parseWeChatEndpoint(input.wechat, `${path}.wechat`)
    : undefined;
  if (telegram === undefined && wechat === undefined)
    fail(path, "must configure at least one private endpoint");
  return {
    id: identifier(input.id, `${path}.id`),
    workspace: absolutePath(input.workspace, `${path}.workspace`),
    ...(telegram === undefined ? {} : { telegram }),
    ...(wechat === undefined ? {} : { wechat }),
  };
}

export function parseConfig(value: unknown): AppConfig {
  const input = record(value, "config");
  exactKeys(
    input,
    [
      "schemaVersion",
      "dataRoot",
      "piProfileDir",
      "minimumFreeBytes",
      "telegramAccounts",
      "wechatAccounts",
      "users",
    ],
    ["mediaMode"],
    "config",
  );
  if (input.schemaVersion !== 1) fail("config.schemaVersion", "expected 1");
  if (
    !Number.isSafeInteger(input.minimumFreeBytes) ||
    Number(input.minimumFreeBytes) < 0
  ) {
    fail("config.minimumFreeBytes", "expected a non-negative safe integer");
  }

  const telegramAccounts = arrayValue(
    input.telegramAccounts,
    "config.telegramAccounts",
  ).map(parseTelegramAccount);
  const wechatAccounts = arrayValue(
    input.wechatAccounts,
    "config.wechatAccounts",
  ).map(parseWeChatAccount);
  const users = arrayValue(input.users, "config.users").map(parseUser);
  if (users.length === 0)
    fail("config.users", "must contain at least one user");

  unique(
    telegramAccounts.map(({ id }) => id),
    "config.telegramAccounts",
  );
  unique(
    wechatAccounts.map(({ id }) => id),
    "config.wechatAccounts",
  );
  unique(
    users.map(({ id }) => id),
    "config.users",
  );

  const telegramAccountIds = new Set(telegramAccounts.map(({ id }) => id));
  const wechatAccountIds = new Set(wechatAccounts.map(({ id }) => id));
  const endpointKeys: string[] = [];
  for (const user of users) {
    if (user.telegram !== undefined) {
      if (!telegramAccountIds.has(user.telegram.account)) {
        fail(
          `config.users.${user.id}.telegram.account`,
          "references an unknown Telegram account",
        );
      }
      endpointKeys.push(
        JSON.stringify([
          "telegram",
          user.telegram.account,
          user.telegram.userId,
          user.telegram.privateChatId,
        ]),
      );
    }
    if (user.wechat !== undefined) {
      if (!wechatAccountIds.has(user.wechat.account)) {
        fail(
          `config.users.${user.id}.wechat.account`,
          "references an unknown WeChat account",
        );
      }
      endpointKeys.push(
        JSON.stringify(["wechat", user.wechat.account, user.wechat.userId]),
      );
    }
  }
  unique(endpointKeys, "config.users endpoints");

  const mediaMode =
    input.mediaMode === undefined
      ? ("always-trigger" as const)
      : input.mediaMode === "always-trigger" ||
          input.mediaMode === "text-trigger"
        ? input.mediaMode
        : fail("config.mediaMode", "expected always-trigger or text-trigger");

  return {
    schemaVersion: 1,
    dataRoot: absolutePath(input.dataRoot, "config.dataRoot"),
    piProfileDir: absolutePath(input.piProfileDir, "config.piProfileDir"),
    minimumFreeBytes: Number(input.minimumFreeBytes),
    mediaMode,
    telegramAccounts,
    wechatAccounts,
    users,
  };
}

export function loadConfig(path: string): AppConfig {
  const metadata = statSync(path, { bigint: true, throwIfNoEntry: false });
  if (metadata === undefined || !metadata.isFile())
    throw new ConfigError("configuration path must be a regular file");
  if (metadata.size > BigInt(MAX_CONFIG_BYTES))
    throw new ConfigError("configuration file is too large");
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new ConfigError(
      `configuration is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }
  return parseConfig(decoded);
}

export function readRequiredSecret(
  environmentName: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!ENV_PATTERN.test(environmentName))
    throw new ConfigError("invalid secret environment reference");
  const value = environment[environmentName];
  if (value === undefined || value.length === 0)
    throw new ConfigError(
      `required secret environment variable is not set: ${environmentName}`,
    );
  return value;
}
