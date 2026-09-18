export type RuntimeErrorCode =
  | "auth"
  | "quota"
  | "rate-limit"
  | "timeout"
  | "network"
  | "rpc"
  | "attestation"
  | "io"
  | "model-unavailable"
  | "provider-error"
  | "unknown";
const CODES = new Set([
  "auth",
  "quota",
  "rate-limit",
  "timeout",
  "network",
  "rpc",
  "attestation",
  "io",
  "model-unavailable",
  "provider-error",
  "unknown",
]);
const PHASES = [
  "preflight",
  "spawn",
  "attest",
  "resolve-model",
  "set-model",
  "set-thinking",
  "prompt",
  "settled",
  "transcript",
  "cleanup",
] as const;
export type RuntimeFailurePhase = (typeof PHASES)[number];
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const HTTP_STATUS =
  /\b(?:http(?:\s+status)?|status(?:\s+code)?)\s*[:=]?\s*([1-5]\d{2})\b/iu;

export interface RuntimeErrorClassification {
  readonly code: RuntimeErrorCode;
  readonly httpStatus?: number;
}

export interface PiRuntimeFailure {
  readonly phase: RuntimeFailurePhase;
  readonly turnId?: string;
  readonly error?: unknown;
  readonly code?: RuntimeErrorCode;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "";
}

function codeFor(text: string, status: number | undefined): RuntimeErrorCode {
  if (/\b(attest(?:ation)?|tool (?:surface|source) mismatch)\b/iu.test(text))
    return "attestation";
  if (/\bmodel (?:is )?(?:unavailable|not found)|unknown model\b/iu.test(text))
    return "model-unavailable";
  if (/\b(quota|insufficient (?:credit|balance)|billing)\b/iu.test(text))
    return "quota";
  if (/\b(rate[ -]?limit|too many requests)\b/iu.test(text) || status === 429)
    return "rate-limit";
  if (
    /\b(unauthorized|forbidden|authentication|invalid (?:api )?key|credential)\b/iu.test(
      text,
    ) ||
    status === 401 ||
    status === 403
  )
    return "auth";
  if (/\b(timeout|timed out|etimedout|aborterror)\b/iu.test(text))
    return "timeout";
  if (
    /\b(econn(?:reset|refused)|enotfound|eai_again|network error|fetch failed|socket hang up)\b/iu.test(
      text,
    )
  )
    return "network";
  if (/\b(json-?rpc|\brpc\b|protocol error)\b/iu.test(text)) return "rpc";
  if (/\b(eacces|enoent|enospc|\beio\b|i\/o error)\b/iu.test(text)) return "io";
  if (
    /\b(provider error|upstream error)\b/iu.test(text) ||
    (status !== undefined && status >= 400)
  )
    return "provider-error";
  return "unknown";
}

export function classifyRuntimeError(
  error: unknown,
): RuntimeErrorClassification {
  const text = errorText(error);
  const matched = HTTP_STATUS.exec(text);
  const status = matched?.[1] === undefined ? undefined : Number(matched[1]);
  const code = codeFor(text, status);
  return status === undefined ? { code } : { code, httpStatus: status };
}

export function logPiRuntimeFailure(input: PiRuntimeFailure): string {
  const classified = classifyRuntimeError(input.error);
  const requestedCode = input.code ?? classified.code;
  const code = CODES.has(requestedCode) ? requestedCode : classified.code;
  const phase = PHASES.includes(input.phase) ? input.phase : "cleanup";
  const failure: {
    event: "pi-runtime-failure";
    phase: RuntimeFailurePhase;
    code: RuntimeErrorCode;
    turnId?: string;
    httpStatus?: number;
    detail?: string;
  } = {
    event: "pi-runtime-failure",
    phase,
    code,
  };
  if (input.turnId !== undefined && TURN_ID.test(input.turnId))
    failure.turnId = input.turnId;
  if (classified.httpStatus !== undefined)
    failure.httpStatus = classified.httpStatus;
  // Bounded detail for the operator: single-machine journald is already
  // operator-only, and debugging world/attestation failures from bare codes
  // repeatedly cost hours. Keep the classified code as the contract; cap the
  // excerpt so logs stay bounded.
  if (input.error !== undefined) {
    const raw =
      input.error instanceof Error ? input.error.message : String(input.error);
    const detail = raw
      .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
      .replace(/(api[-_]?key|access[-_]?token)=\S+/gi, "$1=<redacted>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1_024);
    if (detail !== "") failure.detail = detail;
  }
  const line = JSON.stringify(failure);
  console.error(line);
  return line;
}
