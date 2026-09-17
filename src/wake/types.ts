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
  maxFires: number | null;
  until: string | null;
  fireCount: number;
  lastFiredAt: string | null;
  createdAt: string;
}
