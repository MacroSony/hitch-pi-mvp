export interface RuntimeTurn {
  readonly turnId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly workspace?: string;
  readonly piSessionId?: string;
  readonly transcriptPath?: string;
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly artifacts?: readonly RuntimeArtifact[];
  readonly publishPath?: string;
}

export interface RuntimeArtifact {
  readonly id: string;
  readonly userId: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaKind: "image" | "file";
  readonly mimeType: string;
  readonly displayName: string;
}

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface RuntimeModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly thinkingLevels: readonly ThinkingLevel[];
}

export interface RuntimeResult {
  readonly outcome:
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed-out"
    | "unknown";
  readonly text: string;
  readonly error?: string;
  readonly sessionReusable: boolean;
  readonly transcriptPath?: string;
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly artifacts?: readonly RuntimeArtifact[];
}

export interface AgentRuntime {
  readonly models?: readonly RuntimeModel[];
  run(turn: RuntimeTurn, signal: AbortSignal): Promise<RuntimeResult>;
}

export type FakeRuntimeHandler = (
  turn: RuntimeTurn,
  signal: AbortSignal,
) => Promise<RuntimeResult> | RuntimeResult;

export class FakeAgentRuntime implements AgentRuntime {
  readonly #handler: FakeRuntimeHandler;

  public constructor(
    handler?: FakeRuntimeHandler,
    readonly models: readonly RuntimeModel[] = [],
  ) {
    this.#handler =
      handler ??
      ((turn) => ({
        outcome: "succeeded",
        text: `Fake Pi response: ${turn.prompt}`,
        sessionReusable: true,
      }));
  }

  public run(turn: RuntimeTurn, signal: AbortSignal): Promise<RuntimeResult> {
    return Promise.resolve(this.#handler(turn, signal));
  }
}
