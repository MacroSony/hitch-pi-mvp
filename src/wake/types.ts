export type WakeRecurrence =
  | { kind: "once"; date: string }
  | { kind: "daily" }
  | { kind: "weekly"; weekdays: number[] };

export interface WakeSchedule {
  id: string;
  ownerId: string;
  channel: "telegram" | "wechat" | "wecom";
  endpointId: string;
  /** Legacy files omit action; omitted means wake. */
  action?: "notify" | "wake";
  sessionId: string;
  promptTemplate: string;
  recurrence: WakeRecurrence;
  timeOfDay: string;
  timezone: string;
  enabled: boolean;
  /** Local cancellation is a tombstone and cannot be resumed. */
  cancelled?: boolean;
  /** When true, each fire resets the session's Pi context (fresh transcript)
   *  before enqueueing; the Hitch session and selections are preserved. */
  freshSession?: boolean;
  readonly origin?: {
    readonly callerId: string;
    readonly requestId: string;
    readonly digest: string;
  };
  lastOutcome?: {
    readonly status: "queued" | "skipped" | "failed" | "uncertain";
    readonly at: string;
    readonly turnId?: string;
    readonly deliveryId?: string;
  } | null;
  maxFires: number | null;
  until: string | null;
  fireCount: number;
  lastFiredAt: string | null;
  createdAt: string;
}
