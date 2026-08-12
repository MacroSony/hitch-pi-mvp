export type FailureCategory =
  | "rejected"
  | "busy"
  | "session-quarantined"
  | "model-unavailable"
  | "sandbox-failed"
  | "agent-failed"
  | "delivery-failed"
  | "internal-error";

export class AppError extends Error {
  public constructor(
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
