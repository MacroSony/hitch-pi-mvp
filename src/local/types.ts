/** Fixed, host-only control surface. Not exposed to workspace tools. */
export const LOCAL_METHODS = [
  "targets.list",
  "notify",
  "delivery.get",
  "schedule.create",
  "schedule.list",
  "schedule.set_enabled",
  "schedule.cancel",
] as const;
export type LocalMethod = (typeof LOCAL_METHODS)[number];

export interface LocalCallerConfig {
  readonly id: string;
  readonly tokenEnv: string;
  readonly userIds: readonly string[];
  readonly actions: readonly LocalMethod[];
}

export interface LocalControlConfig {
  /** Socket is fixed beneath the private data root: control/hitch.sock. */
  readonly callers: readonly LocalCallerConfig[];
}

export interface LocalRequest {
  readonly method: LocalMethod;
  readonly params: Readonly<Record<string, unknown>>;
}

/** Receives an already authenticated static caller; still checks owner/action. */
export type LocalHandler = (
  caller: LocalCallerConfig,
  request: LocalRequest,
) => unknown | Promise<unknown>;

export class LocalControlError extends Error {
  public constructor(
    public readonly code:
      | "rejected"
      | "forbidden"
      | "not-found"
      | "conflict"
      | "busy"
      | "unavailable",
  ) {
    super(code);
    this.name = "LocalControlError";
  }
}
