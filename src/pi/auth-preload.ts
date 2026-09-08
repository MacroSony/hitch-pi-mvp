import {
  ModelRuntime,
  getAgentDir,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";

import { join } from "node:path";

import { SharedCredentialStore } from "./shared-credentials.js";

export const SHARED_AUTH_ENV = "HITCH_SHARED_AUTH_PATH";
export const SHARED_AUTH_FAILED = "shared-auth-failed";

let installed = false;

export function installSharedAuthPreload(): void {
  if (installed) return;
  installed = true;

  const originalCreate = ModelRuntime.create;

  ModelRuntime.create = async function (
    options?: CreateModelRuntimeOptions,
  ): Promise<ModelRuntime> {
    // Pinned CLI supplies its per-user default authPath explicitly. Override
    // only that known default; never accept an unrelated caller-selected store.
    if (
      options?.credentials !== undefined ||
      (options?.authPath !== undefined &&
        options.authPath !== join(getAgentDir(), "auth.json"))
    ) {
      throw new Error(SHARED_AUTH_FAILED);
    }
    const sharedAuthPath = process.env[SHARED_AUTH_ENV];
    if (
      typeof sharedAuthPath !== "string" ||
      sharedAuthPath.trim().length === 0
    ) {
      throw new Error(SHARED_AUTH_FAILED);
    }
    let credentials: SharedCredentialStore;
    try {
      credentials = new SharedCredentialStore(sharedAuthPath);
    } catch {
      throw new Error(SHARED_AUTH_FAILED);
    }
    try {
      const runtime = await originalCreate.call(ModelRuntime, {
        ...options,
        credentials,
      });
      process.env.HITCH_SHARED_AUTH_INSTALLED = "1";
      return runtime;
    } catch {
      throw new Error(SHARED_AUTH_FAILED);
    }
  };
}

installSharedAuthPreload();
