import {
  lstatSync,
  mkdirSync,
  realpathSync,
  statfsSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative } from "node:path";

import type { AppConfig } from "../config/config.js";

export class FoundationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FoundationError";
  }
}

export interface DirectoryIdentity {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

export interface PublishedEndpoint {
  readonly kind: "telegram" | "wechat" | "wecom";
  readonly accountId: string;
  readonly platformUserId: string;
  readonly privateChatId: string | null;
  readonly tupleKey: string;
}

export interface PublishedUser {
  readonly id: string;
  readonly workspace: DirectoryIdentity;
  readonly endpoints: readonly PublishedEndpoint[];
}

export interface ValidatedTopology {
  readonly dataRoot: DirectoryIdentity;
  readonly piProfileDir: DirectoryIdentity;
  readonly wechatStateDirs: readonly DirectoryIdentity[];
  readonly users: readonly PublishedUser[];
}

function isWithin(left: string, right: string): boolean {
  const child = relative(left, right);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function overlaps(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function inspectPrivateDirectory(
  path: string,
  label: string,
  create: boolean,
): DirectoryIdentity {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const linkMetadata = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (
    linkMetadata === undefined ||
    !linkMetadata.isDirectory() ||
    linkMetadata.isSymbolicLink()
  ) {
    throw new FoundationError(
      `${label} must be an existing directory, not a symbolic link`,
    );
  }
  const canonical = realpathSync(path);
  if (canonical !== path)
    throw new FoundationError(
      `${label} must be a canonical path without symbolic-link components`,
    );
  const metadata = statSync(path, { bigint: true });
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && metadata.uid !== BigInt(currentUid)) {
    throw new FoundationError(`${label} must be owned by the service user`);
  }
  if ((metadata.mode & 0o077n) !== 0n)
    throw new FoundationError(
      `${label} must not grant group or other permissions`,
    );
  return {
    path: canonical,
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
  };
}

function assertDisjoint(
  roots: readonly {
    readonly label: string;
    readonly identity: DirectoryIdentity;
  }[],
): void {
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    const left = roots[leftIndex];
    if (left === undefined) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < roots.length;
      rightIndex += 1
    ) {
      const right = roots[rightIndex];
      if (right === undefined) continue;
      if (
        left.identity.device === right.identity.device &&
        left.identity.inode === right.identity.inode
      ) {
        throw new FoundationError(
          `${left.label} and ${right.label} resolve to the same directory`,
        );
      }
      if (overlaps(left.identity.path, right.identity.path)) {
        throw new FoundationError(
          `${left.label} and ${right.label} must not be nested or overlap`,
        );
      }
    }
  }
}

function telegramTuple(
  accountId: string,
  userId: string,
  privateChatId: string,
): string {
  return JSON.stringify(["telegram", accountId, userId, privateChatId]);
}

function wechatTuple(accountId: string, userId: string): string {
  return JSON.stringify(["wechat", accountId, userId]);
}

function wecomTuple(accountId: string, userId: string): string {
  return JSON.stringify(["wecom", accountId, userId]);
}

export function validateTopology(config: AppConfig): ValidatedTopology {
  const dataRoot = inspectPrivateDirectory(config.dataRoot, "data root", true);
  const piProfileDir = inspectPrivateDirectory(
    config.piProfileDir,
    "Pi profile directory",
    false,
  );
  const wechatStateDirs = config.wechatAccounts.map((account) =>
    inspectPrivateDirectory(
      account.stateDir,
      `WeChat account ${account.id} state directory`,
      false,
    ),
  );
  const users = config.users.map((user) => {
    const workspace = inspectPrivateDirectory(
      user.workspace,
      `user ${user.id} workspace`,
      false,
    );
    const endpoints: PublishedEndpoint[] = [];
    if (user.telegram !== undefined) {
      endpoints.push({
        kind: "telegram",
        accountId: user.telegram.account,
        platformUserId: user.telegram.userId,
        privateChatId: user.telegram.privateChatId,
        tupleKey: telegramTuple(
          user.telegram.account,
          user.telegram.userId,
          user.telegram.privateChatId,
        ),
      });
    }
    if (user.wechat !== undefined) {
      endpoints.push({
        kind: "wechat",
        accountId: user.wechat.account,
        platformUserId: user.wechat.userId,
        privateChatId: null,
        tupleKey: wechatTuple(user.wechat.account, user.wechat.userId),
      });
    }
    if (user.wecom !== undefined) {
      endpoints.push({
        kind: "wecom",
        accountId: user.wecom.account,
        platformUserId: user.wecom.userId,
        privateChatId: null,
        tupleKey: wecomTuple(user.wecom.account, user.wecom.userId),
      });
    }
    return { id: user.id, workspace, endpoints };
  });

  assertDisjoint([
    { label: "data root", identity: dataRoot },
    { label: "Pi profile directory", identity: piProfileDir },
    ...wechatStateDirs.map((identity, index) => ({
      label: `WeChat account ${config.wechatAccounts[index]?.id ?? index} state directory`,
      identity,
    })),
    ...users.map((user) => ({
      label: `user ${user.id} workspace`,
      identity: user.workspace,
    })),
  ]);

  const free = statfsSync(dataRoot.path, { bigint: true });
  const availableBytes = free.bavail * free.bsize;
  if (availableBytes < BigInt(config.minimumFreeBytes)) {
    throw new FoundationError(
      "data root is below the configured free-space threshold",
    );
  }
  return { dataRoot, piProfileDir, wechatStateDirs, users };
}
