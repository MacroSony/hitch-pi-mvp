export interface RuntimeTurn {
  readonly turnId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly prompt: string;
}

export interface RuntimeResult {
  readonly outcome: "succeeded" | "failed" | "cancelled" | "unknown";
  readonly text: string;
  readonly sessionReusable: boolean;
}

export interface AgentRuntime {
  run(turn: RuntimeTurn, signal: AbortSignal): Promise<RuntimeResult>;
}

export type FakeRuntimeHandler = (
  turn: RuntimeTurn,
  signal: AbortSignal,
) => Promise<RuntimeResult> | RuntimeResult;

export class FakeAgentRuntime implements AgentRuntime {
  readonly #handler: FakeRuntimeHandler;

  public constructor(handler?: FakeRuntimeHandler) {
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
