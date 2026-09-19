export type WakeRecurrence =
  | { kind: "once"; date: string }
  | { kind: "daily" }
  | { kind: "weekly"; weekdays: number[] };

export interface WakeSchedule {
  id: string;
  ownerId: string;
  channel: "telegram" | "wechat" | "wecom";
  endpointId: string;
  sessionId: string;
  promptTemplate: string;
  recurrence: WakeRecurrence;
  timeOfDay: string;
  timezone: string;
  enabled: boolean;
  /** When true, each fire resets the session's Pi context (fresh transcript)
   *  before enqueueing; the Hitch session and selections are preserved. */
  freshSession?: boolean;
  maxFires: number | null;
  until: string | null;
  fireCount: number;
  lastFiredAt: string | null;
  createdAt: string;
}
