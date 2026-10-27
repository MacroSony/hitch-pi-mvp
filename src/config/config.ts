import { readFileSync, statSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

import { LOCAL_METHODS } from "../local/types.js";
import type {
  LocalCallerConfig,
  LocalControlConfig,
  LocalMethod,
} from "../local/types.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_LOCAL_CONTROL_CALLERS = 8;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const DEFAULT_MAX_CONCURRENT_TURNS = 2;
const MIN_MAX_CONCURRENT_TURNS = 1;
const MAX_MAX_CONCURRENT_TURNS = 8;
const DISCORD_SNOWFLAKE_PATTERN = /^[1-9][0-9]{16,19}$/u;
const MAX_DISCORD_SNOWFLAKE = BigInt("18446744073709551615");

export interface TelegramAccountConfig {
  readonly id: string;
  readonly botTokenEnv: string;
}

export interface DiscordAccountConfig {
  readonly id: string;
  readonly botTokenEnv: string;
  readonly messageContent?: boolean;
}

export interface WeChatAccountConfig {
  readonly id: string;
  readonly stateDir: string;
}

export interface WeComAccountConfig {
  readonly id: string;
  readonly credentialsFile: string;
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

export interface WeComEndpointConfig {
  readonly account: string;
  readonly userId: string;
}

export interface DiscordDmEndpointConfig {
  readonly mode: "dm";
  readonly account: string;
  readonly userId: string;
  readonly channelId: string;
}

export interface DiscordServerEndpointConfig {
  readonly mode: "server";
  readonly account: string;
  readonly guildId: string;
  readonly channelIds: readonly string[];
  readonly adminUserIds: readonly string[];
}

export type DiscordEndpointConfig =
  | DiscordDmEndpointConfig
  | DiscordServerEndpointConfig;

export interface UserConfig {
  readonly id: string;
  readonly workspace: string;
  /** Default persona profile for sessions without an explicit !profile/!preset
   *  selection. The fallback re-applies every turn; clearing a selection does
   *  not permanently defeat it. */
  readonly forgeProfile?: string;
  readonly telegram?: TelegramEndpointConfig;
  readonly wechat?: WeChatEndpointConfig;
  readonly wecom?: WeComEndpointConfig;
  readonly discord?: DiscordEndpointConfig;
}

export type MediaMode = "always-trigger" | "text-trigger";

export interface WebSearchConfig {
  readonly provider: "tavily";
  readonly apiKeyEnv: string;
  readonly enabledUsers: readonly string[];
}

export interface PaintConfig {
  readonly deliveryMode?: "direct" | "agent";
  readonly origin: string;
  readonly allowPrivate: boolean;
  readonly workflowFile: string;
  readonly enabledUsers: readonly string[];
}

export interface ForgeConfig {
  readonly root: string;
  readonly enabledUsers: readonly string[];
}

export interface AppConfig {
  readonly schemaVersion: 1;
  readonly dataRoot: string;
  readonly piProfileDir: string;
  readonly minimumFreeBytes: number;
  readonly mediaMode: MediaMode;
  readonly maxConcurrentTurns: number;
  readonly telegramAccounts: readonly TelegramAccountConfig[];
  readonly wechatAccounts: readonly WeChatAccountConfig[];
  readonly wecomAccounts: readonly WeComAccountConfig[];
  /** Optional for compatibility with pre-Discord AppConfig fixtures. */
  readonly discordAccounts?: readonly DiscordAccountConfig[];
  readonly users: readonly UserConfig[];
  readonly webSearch?: WebSearchConfig;
  readonly paint?: PaintConfig;
  readonly forge?: ForgeConfig;
  readonly antigravity?: boolean;
  readonly localControl?: LocalControlConfig;
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

function parseDiscordAccount(
  value: unknown,
  index: number,
): DiscordAccountConfig {
  const path = `config.discordAccounts[${index}]`;
  const input = record(value, path);
  exactKeys(input, ["id", "botTokenEnv"], ["messageContent"], path);
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
  if (
    input.messageContent !== undefined &&
    typeof input.messageContent !== "boolean"
  )
    fail(`${path}.messageContent`, "expected a boolean");
  return {
    id: identifier(input.id, `${path}.id`),
    botTokenEnv,
    ...(input.messageContent === undefined
      ? {}
      : { messageContent: input.messageContent as boolean }),
  };
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

function parseWeComAccount(value: unknown, index: number): WeComAccountConfig {
  const path = `config.wecomAccounts[${index}]`;
  const input = record(value, path);
  exactKeys(input, ["id", "credentialsFile"], [], path);
  return {
    id: identifier(input.id, `${path}.id`),
    credentialsFile: absolutePath(
      input.credentialsFile,
      `${path}.credentialsFile`,
    ),
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

function parseWeComEndpoint(value: unknown, path: string): WeComEndpointConfig {
  const input = record(value, path);
  exactKeys(input, ["account", "userId"], [], path);
  return {
    account: identifier(input.account, `${path}.account`),
    userId: remoteIdentifier(input.userId, `${path}.userId`),
  };
}

function discordSnowflake(value: unknown, path: string): string {
  const parsed = stringValue(value, path, 20);
  if (
    !DISCORD_SNOWFLAKE_PATTERN.test(parsed) ||
    BigInt(parsed) > MAX_DISCORD_SNOWFLAKE
  ) {
    fail(path, "must be a canonical nonzero Discord snowflake");
  }
  return parsed;
}

function parseDiscordEndpoint(
  value: unknown,
  path: string,
): DiscordEndpointConfig {
  const input = record(value, path);
  if (input.mode === "dm") {
    exactKeys(input, ["mode", "account", "userId", "channelId"], [], path);
    return {
      mode: "dm",
      account: identifier(input.account, `${path}.account`),
      userId: discordSnowflake(input.userId, `${path}.userId`),
      channelId: discordSnowflake(input.channelId, `${path}.channelId`),
    };
  }
  if (input.mode === "server") {
    exactKeys(
      input,
      ["mode", "account", "guildId", "channelIds", "adminUserIds"],
      [],
      path,
    );
    const rawChannels = arrayValue(input.channelIds, `${path}.channelIds`);
    if (rawChannels.length < 1 || rawChannels.length > 32)
      fail(`${path}.channelIds`, "must contain 1 to 32 channels");
    const channelIds = rawChannels.map((item, index) =>
      discordSnowflake(item, `${path}.channelIds[${index}]`),
    );
    unique(channelIds, `${path}.channelIds`);
    const rawAdmins = arrayValue(input.adminUserIds, `${path}.adminUserIds`);
    if (rawAdmins.length < 1 || rawAdmins.length > 32)
      fail(`${path}.adminUserIds`, "must contain 1 to 32 administrators");
    const adminUserIds = rawAdmins.map((item, index) =>
      discordSnowflake(item, `${path}.adminUserIds[${index}]`),
    );
    unique(adminUserIds, `${path}.adminUserIds`);
    return {
      mode: "server",
      account: identifier(input.account, `${path}.account`),
      guildId: discordSnowflake(input.guildId, `${path}.guildId`),
      channelIds,
      adminUserIds,
    };
  }
  fail(`${path}.mode`, "expected dm or server");
}

function parseLocalCaller(
  value: unknown,
  index: number,
  knownUserIds: ReadonlySet<string>,
): LocalCallerConfig {
  const path = `config.localControl.callers[${index}]`;
  const input = record(value, path);
  exactKeys(input, ["id", "tokenEnv", "userIds", "actions"], [], path);

  const id = identifier(input.id, `${path}.id`);
  const tokenEnv = stringValue(input.tokenEnv, `${path}.tokenEnv`, 128);
  if (!ENV_PATTERN.test(tokenEnv)) {
    fail(
      `${path}.tokenEnv`,
      "must name an uppercase environment variable, not contain a raw token",
    );
  }

  const rawUserIds = arrayValue(input.userIds, `${path}.userIds`);
  if (rawUserIds.length === 0)
    fail(`${path}.userIds`, "must contain at least one user");
  const userIds = rawUserIds.map((item, userIndex) =>
    identifier(item, `${path}.userIds[${userIndex}]`),
  );
  unique(userIds, `${path}.userIds`);
  for (const userId of userIds) {
    if (!knownUserIds.has(userId)) {
      fail(`${path}.userIds`, `references an unknown user: ${userId}`);
    }
  }

  const rawActions = arrayValue(input.actions, `${path}.actions`);
  if (rawActions.length === 0)
    fail(`${path}.actions`, "must contain at least one action");
  const knownMethods = new Set<string>(LOCAL_METHODS);
  const actions = rawActions.map((item, actionIndex) => {
    const method = stringValue(item, `${path}.actions[${actionIndex}]`, 64);
    if (!knownMethods.has(method)) {
      fail(`${path}.actions[${actionIndex}]`, "is not a local control method");
    }
    return method as LocalMethod;
  });
  unique(actions, `${path}.actions`);

  return { id, tokenEnv, userIds, actions };
}

function parseUser(value: unknown, index: number): UserConfig {
  const path = `config.users[${index}]`;
  const input = record(value, path);
  exactKeys(
    input,
    ["id", "workspace"],
    ["telegram", "wechat", "wecom", "discord", "forgeProfile"],
    path,
  );
  const telegram = Object.hasOwn(input, "telegram")
    ? parseTelegramEndpoint(input.telegram, `${path}.telegram`)
    : undefined;
  const wechat = Object.hasOwn(input, "wechat")
    ? parseWeChatEndpoint(input.wechat, `${path}.wechat`)
    : undefined;
  const wecom = Object.hasOwn(input, "wecom")
    ? parseWeComEndpoint(input.wecom, `${path}.wecom`)
    : undefined;
  const discord = Object.hasOwn(input, "discord")
    ? parseDiscordEndpoint(input.discord, `${path}.discord`)
    : undefined;
  if (
    telegram === undefined &&
    wechat === undefined &&
    wecom === undefined &&
    discord === undefined
  )
    fail(path, "must configure at least one private endpoint");
  if (
    discord !== undefined &&
    (telegram !== undefined || wechat !== undefined || wecom !== undefined)
  )
    fail(path, "Discord cannot be mixed with legacy channel endpoints");
  const forgeProfile = Object.hasOwn(input, "forgeProfile")
    ? identifier(input.forgeProfile, `${path}.forgeProfile`)
    : undefined;
  return {
    id: identifier(input.id, `${path}.id`),
    workspace: absolutePath(input.workspace, `${path}.workspace`),
    ...(forgeProfile === undefined ? {} : { forgeProfile }),
    ...(telegram === undefined ? {} : { telegram }),
    ...(wechat === undefined ? {} : { wechat }),
    ...(wecom === undefined ? {} : { wecom }),
    ...(discord === undefined ? {} : { discord }),
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
    [
      "wecomAccounts",
      "discordAccounts",
      "mediaMode",
      "maxConcurrentTurns",
      "webSearch",
      "paint",
      "forge",
      "antigravity",
      "localControl",
    ],
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
  const wecomAccounts =
    input.wecomAccounts === undefined
      ? []
      : arrayValue(input.wecomAccounts, "config.wecomAccounts").map(
          parseWeComAccount,
        );
  const discordAccounts =
    input.discordAccounts === undefined
      ? []
      : arrayValue(input.discordAccounts, "config.discordAccounts").map(
          parseDiscordAccount,
        );
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
    wecomAccounts.map(({ id }) => id),
    "config.wecomAccounts",
  );
  unique(
    users.map(({ id }) => id),
    "config.users",
  );
  unique(
    discordAccounts.map(({ id }) => id),
    "config.discordAccounts",
  );

  const telegramAccountIds = new Set(telegramAccounts.map(({ id }) => id));
  const wechatAccountIds = new Set(wechatAccounts.map(({ id }) => id));
  const wecomAccountIds = new Set(wecomAccounts.map(({ id }) => id));
  const discordAccountIds = new Set(discordAccounts.map(({ id }) => id));
  const endpointKeys: string[] = [];
  const discordScopeKeys: string[] = [];
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
    if (user.wecom !== undefined) {
      if (!wecomAccountIds.has(user.wecom.account)) {
        fail(
          `config.users.${user.id}.wecom.account`,
          "references an unknown WeCom account",
        );
      }
      endpointKeys.push(
        JSON.stringify(["wecom", user.wecom.account, user.wecom.userId]),
      );
    }
    if (user.discord !== undefined) {
      if (!discordAccountIds.has(user.discord.account)) {
        fail(
          `config.users.${user.id}.discord.account`,
          "references an unknown Discord account",
        );
      }
      const scopeId =
        user.discord.mode === "dm" ? user.discord.userId : user.discord.guildId;
      discordScopeKeys.push(
        JSON.stringify([
          "discord",
          user.discord.account,
          user.discord.mode,
          scopeId,
        ]),
      );
      if (user.discord.mode === "dm") {
        endpointKeys.push(
          JSON.stringify([
            "discord",
            user.discord.account,
            "dm",
            user.discord.userId,
            user.discord.channelId,
          ]),
        );
      } else {
        for (const channelId of user.discord.channelIds) {
          endpointKeys.push(
            JSON.stringify([
              "discord",
              user.discord.account,
              "server",
              user.discord.guildId,
              channelId,
            ]),
          );
        }
      }
    }
  }
  unique(endpointKeys, "config.users endpoints");
  unique(discordScopeKeys, "config.users Discord scopes");

  const mediaMode =
    input.mediaMode === undefined
      ? ("always-trigger" as const)
      : input.mediaMode === "always-trigger" ||
          input.mediaMode === "text-trigger"
        ? input.mediaMode
        : fail("config.mediaMode", "expected always-trigger or text-trigger");
  const maxConcurrentTurnsValue: unknown = input.maxConcurrentTurns;
  const maxConcurrentTurns =
    maxConcurrentTurnsValue === undefined
      ? DEFAULT_MAX_CONCURRENT_TURNS
      : maxConcurrentTurnsValue;
  if (
    typeof maxConcurrentTurns !== "number" ||
    !Number.isSafeInteger(maxConcurrentTurns) ||
    maxConcurrentTurns < MIN_MAX_CONCURRENT_TURNS ||
    maxConcurrentTurns > MAX_MAX_CONCURRENT_TURNS
  ) {
    fail(
      "config.maxConcurrentTurns",
      `expected a safe integer from ${MIN_MAX_CONCURRENT_TURNS} to ${MAX_MAX_CONCURRENT_TURNS}`,
    );
  }

  let webSearch: WebSearchConfig | undefined;
  if (input.webSearch !== undefined) {
    const wsInput = record(input.webSearch, "config.webSearch");
    exactKeys(
      wsInput,
      ["provider", "apiKeyEnv", "enabledUsers"],
      [],
      "config.webSearch",
    );
    if (wsInput.provider !== "tavily") {
      fail("config.webSearch.provider", "expected 'tavily'");
    }
    const apiKeyEnv = stringValue(
      wsInput.apiKeyEnv,
      "config.webSearch.apiKeyEnv",
      128,
    );
    if (!ENV_PATTERN.test(apiKeyEnv)) {
      fail(
        "config.webSearch.apiKeyEnv",
        "must be an uppercase environment variable name",
      );
    }
    const rawEnabledUsers = arrayValue(
      wsInput.enabledUsers,
      "config.webSearch.enabledUsers",
    );
    const enabledUsers = rawEnabledUsers.map((item, index) =>
      identifier(item, `config.webSearch.enabledUsers[${index}]`),
    );
    unique(enabledUsers, "config.webSearch.enabledUsers");

    const userIds = new Set(users.map(({ id }) => id));
    for (const userId of enabledUsers) {
      if (!userIds.has(userId)) {
        fail(
          "config.webSearch.enabledUsers",
          `references an unknown user: ${userId}`,
        );
      }
    }
    webSearch = {
      provider: "tavily",
      apiKeyEnv,
      enabledUsers,
    };
  }

  let paint: PaintConfig | undefined;
  if (input.paint !== undefined) {
    const resource = record(input.paint, "config.paint");
    exactKeys(
      resource,
      ["origin", "allowPrivate", "workflowFile", "enabledUsers"],
      ["deliveryMode"],
      "config.paint",
    );
    const origin = stringValue(resource.origin, "config.paint.origin", 2048);
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      fail("config.paint.origin", "expected an HTTP(S) origin");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      CONTROL_PATTERN.test(origin)
    )
      fail(
        "config.paint.origin",
        "expected an HTTP(S) origin without path or credentials",
      );
    if (typeof resource.allowPrivate !== "boolean")
      fail("config.paint.allowPrivate", "expected a boolean");
    const enabledUsers = arrayValue(
      resource.enabledUsers,
      "config.paint.enabledUsers",
    ).map((item, index) =>
      identifier(item, `config.paint.enabledUsers[${index}]`),
    );
    unique(enabledUsers, "config.paint.enabledUsers");
    if (enabledUsers.length > 8)
      fail("config.paint.enabledUsers", "at most 8 owners may be enabled");
    if (
      enabledUsers.some(
        (id) =>
          !users.some((user) => user.id === id && user.discord !== undefined),
      )
    )
      fail(
        "config.paint.enabledUsers",
        "must reference configured Discord owners",
      );
    if (
      resource.deliveryMode !== undefined &&
      resource.deliveryMode !== "direct" &&
      resource.deliveryMode !== "agent"
    )
      fail("config.paint.deliveryMode", "expected direct or agent");
    paint = {
      deliveryMode: resource.deliveryMode ?? "direct",
      origin: parsed.origin,
      allowPrivate: resource.allowPrivate,
      workflowFile: absolutePath(
        resource.workflowFile,
        "config.paint.workflowFile",
      ),
      enabledUsers,
    };
  }

  let forge: ForgeConfig | undefined;
  if (input.forge !== undefined) {
    const resource = record(input.forge, "config.forge");
    exactKeys(resource, ["root", "enabledUsers"], [], "config.forge");
    const enabledUsers = arrayValue(
      resource.enabledUsers,
      "config.forge.enabledUsers",
    ).map((item, index) =>
      identifier(item, `config.forge.enabledUsers[${index}]`),
    );
    unique(enabledUsers, "config.forge.enabledUsers");
    const known = new Set(users.map((user) => user.id));
    if (enabledUsers.some((user) => !known.has(user)))
      fail("config.forge.enabledUsers", "references an unknown user");
    forge = {
      root: absolutePath(resource.root, "config.forge.root"),
      enabledUsers,
    };
  }

  let localControl: LocalControlConfig | undefined;
  if (input.localControl !== undefined) {
    const control = record(input.localControl, "config.localControl");
    exactKeys(control, ["callers"], [], "config.localControl");
    const rawCallers = arrayValue(
      control.callers,
      "config.localControl.callers",
    );
    if (rawCallers.length === 0)
      fail("config.localControl.callers", "must contain at least one caller");
    if (rawCallers.length > MAX_LOCAL_CONTROL_CALLERS) {
      fail(
        "config.localControl.callers",
        `must contain at most ${MAX_LOCAL_CONTROL_CALLERS} callers`,
      );
    }
    const knownUserIds = new Set(users.map((user) => user.id));
    const callers = rawCallers.map((item, index) =>
      parseLocalCaller(item, index, knownUserIds),
    );
    unique(
      callers.map((caller) => caller.id),
      "config.localControl.callers",
    );
    localControl = { callers };
  }

  let antigravity: boolean | undefined;
  if (input.antigravity !== undefined) {
    if (typeof input.antigravity !== "boolean") {
      fail("config.antigravity", "expected a boolean");
    }
    antigravity = input.antigravity;
  }

  return {
    schemaVersion: 1,
    dataRoot: absolutePath(input.dataRoot, "config.dataRoot"),
    piProfileDir: absolutePath(input.piProfileDir, "config.piProfileDir"),
    minimumFreeBytes: Number(input.minimumFreeBytes),
    mediaMode,
    maxConcurrentTurns,
    telegramAccounts,
    wechatAccounts,
    wecomAccounts,
    discordAccounts,
    users,
    ...(webSearch === undefined ? {} : { webSearch }),
    ...(paint === undefined ? {} : { paint }),
    ...(forge === undefined ? {} : { forge }),
    antigravity: antigravity ?? false,
    ...(localControl === undefined ? {} : { localControl }),
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
