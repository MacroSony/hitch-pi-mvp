import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import {
  HitchStore,
  type IdSource,
  type MessageIdentity,
} from "../src/app/store.js";
import type { RuntimeModel } from "../src/runtime/runtime.js";

const MODEL: RuntimeModel = {
  provider: "fixture",
  id: "fake",
  name: "Fake",
  reasoning: false,
  input: ["text"],
  thinkingLevels: ["off"],
  contextWindow: 200_000,
};

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture(): {
  readonly root: string;
  readonly store: HitchStore;
  readonly foundation: ReturnType<typeof bootstrapFoundation>;
  readonly endpoint: NonNullable<
    ReturnType<HitchStore["resolveTelegramEndpoint"]>
  >;
} {
  const root = mkdtempSync(join(tmpdir(), "hitch-context-status-"));
  const dataRoot = join(root, "data");
  const profile = join(root, "profile");
  const workspace = join(root, "workspace");
  privateDirectory(profile);
  privateDirectory(workspace);
  const foundation = bootstrapFoundation(
    parseConfig({
      schemaVersion: 1,
      dataRoot,
      piProfileDir: profile,
      minimumFreeBytes: 0,
      telegramAccounts: [{ id: "primary", botTokenEnv: "HITCH_TEST_TOKEN" }],
      wechatAccounts: [],
      users: [
        {
          id: "alice",
          workspace,
          telegram: {
            account: "primary",
            userId: "101",
            privateChatId: "101",
          },
        },
      ],
    }),
    { now: () => 1_000 },
  );
  let nextId = 0;
  const ids: IdSource = {
    next: (kind) => `${kind}_test_${++nextId}`,
  };
  const store = new HitchStore(foundation.database, ids, { now: () => 2_000 });
  const endpoint = store.resolveTelegramEndpoint("primary", "101", "101");
  assert.ok(endpoint !== null);
  return { root, store, foundation, endpoint };
}

function identity(
  endpoint: NonNullable<ReturnType<HitchStore["resolveTelegramEndpoint"]>>,
  idempotencyKey: string,
): MessageIdentity {
  return { endpoint, idempotencyKey, contentDigest: idempotencyKey };
}

test("completed-turn context is persisted, rendered, and invalidated by reset/model changes", () => {
  const value = fixture();
  try {
    value.store.executeCommand(
      identity(value.endpoint, "model"),
      { kind: "model", selector: "fixture/fake" },
      "!model fixture/fake",
      [MODEL],
    );
    const admitted = value.store.admitPrompt(
      identity(value.endpoint, "prompt"),
      "hello",
    );
    const claimed = value.store.claimNextTurn("alice");
    assert.ok(claimed !== null);
    assert.equal(claimed.turnId, admitted.turnId);
    value.store.completeTurn(claimed, {
      outcome: "succeeded",
      text: "done",
      sessionReusable: true,
      modelProvider: "fixture",
      modelId: "fake",
      contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 999 },
    });
    const stored = value.foundation.database.connection
      .prepare("SELECT context_usage FROM sessions WHERE id = ?")
      .get(claimed.sessionId) as { context_usage: string | null };
    assert.equal(JSON.parse(stored.context_usage ?? "null").percent, 25);

    value.store.executeCommand(
      identity(value.endpoint, "status"),
      { kind: "status" },
      "!status",
      [MODEL],
    );
    const status = value.foundation.database.connection
      .prepare(
        "SELECT payload_text FROM outbox ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get() as { payload_text: string };
    assert.match(status.payload_text, /Context: ~50000 \/ 200000 \(25%\)/u);
    assert.match(status.payload_text, /last completed turn/u);

    const beforeReset = value.foundation.database.connection
      .prepare("SELECT pi_session_id FROM sessions WHERE id = ?")
      .get(claimed.sessionId) as { pi_session_id: string };
    value.store.resetSessionPiStateForWake(value.endpoint.id, "alice");
    const afterReset = value.foundation.database.connection
      .prepare("SELECT pi_session_id, context_usage FROM sessions WHERE id = ?")
      .get(claimed.sessionId) as {
      pi_session_id: string;
      context_usage: string | null;
    };
    assert.notEqual(afterReset.pi_session_id, beforeReset.pi_session_id);
    assert.equal(afterReset.context_usage, null);

    value.store.executeCommand(
      identity(value.endpoint, "model-again"),
      { kind: "model", selector: "fixture/fake" },
      "!model fixture/fake",
      [MODEL],
    );
    assert.equal(
      (
        value.foundation.database.connection
          .prepare("SELECT context_usage FROM sessions WHERE id = ?")
          .get(claimed.sessionId) as { context_usage: string | null }
      ).context_usage,
      null,
    );
  } finally {
    value.foundation.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("compact completion explicitly clears a previous context snapshot", () => {
  const value = fixture();
  try {
    value.store.executeCommand(
      identity(value.endpoint, "model"),
      { kind: "model", selector: "fixture/fake" },
      "!model fixture/fake",
      [MODEL],
    );
    const admitted = value.store.admitPrompt(
      identity(value.endpoint, "prompt"),
      "hello",
    );
    const claimed = value.store.claimNextTurn("alice");
    assert.ok(claimed !== null);
    value.store.completeTurn(claimed, {
      outcome: "succeeded",
      text: "done",
      sessionReusable: true,
      modelProvider: "fixture",
      modelId: "fake",
      contextUsage: { tokens: 1, contextWindow: 200_000, percent: 0 },
    });
    const compact = value.store.executeCommand(
      identity(value.endpoint, "compact"),
      { kind: "compact" },
      "!compact",
    );
    const compactTurn = value.store.claimNextTurn("alice");
    assert.ok(compactTurn !== null);
    assert.equal(compactTurn.turnId, compact.turnId);
    value.store.completeTurn(compactTurn, {
      outcome: "succeeded",
      text: "compacted",
      sessionReusable: true,
      contextUsage: null,
    });
    assert.equal(
      (
        value.foundation.database.connection
          .prepare("SELECT context_usage FROM sessions WHERE id = ?")
          .get(compactTurn.sessionId) as { context_usage: string | null }
      ).context_usage,
      null,
    );
    void admitted;
  } finally {
    value.foundation.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});
