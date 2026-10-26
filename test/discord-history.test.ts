import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HitchStore,
  type EndpointContext,
  type ClaimedTurn,
} from "../src/app/store.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { MediaStore } from "../src/media/media-store.js";
import type { RuntimeArtifact } from "../src/runtime/runtime.js";

function environment() {
  const root = mkdtempSync(join(tmpdir(), "hitch-history-boundary-"));
  chmodSync(root, 0o700);
  const directory = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    return path;
  };
  const config = parseConfig({
    schemaVersion: 1,
    dataRoot: directory("data"),
    piProfileDir: directory("profile"),
    minimumFreeBytes: 0,
    telegramAccounts: [],
    wechatAccounts: [],
    discordAccounts: [{ id: "bot", botTokenEnv: "FIXTURE_TOKEN" }],
    users: [
      {
        id: "a",
        workspace: directory("a"),
        discord: {
          mode: "dm",
          account: "bot",
          userId: "20000000000000001",
          channelId: "20000000000000021",
        },
      },
      {
        id: "b",
        workspace: directory("b"),
        discord: {
          mode: "dm",
          account: "bot",
          userId: "20000000000000002",
          channelId: "20000000000000022",
        },
      },
    ],
  });
  let foundation = bootstrapFoundation(config);
  let store = new HitchStore(foundation.database);
  const media = new MediaStore(config.dataRoot, 0);
  let serial = 0;
  const endpoint = (owner: "a" | "b") => {
    const e = store.resolveDiscordEndpoint(
      "bot",
      "dm",
      owner === "a" ? "20000000000000001" : "20000000000000002",
      owner === "a" ? "20000000000000021" : "20000000000000022",
    );
    assert.ok(e);
    return e;
  };
  const identity = (e: EndpointContext) => {
    const key = "fixture-" + ++serial;
    return {
      endpoint: e,
      idempotencyKey: key,
      contentDigest: createHash("sha256").update(key).digest("hex"),
    };
  };
  const queue = (
    owner: "a" | "b",
    artifacts: readonly RuntimeArtifact[] = [],
  ) => store.admitPrompt(identity(endpoint(owner)), "fixture", artifacts);
  const claim = (owner: "a" | "b") => {
    const turn = store.claimNextTurn(owner);
    assert.ok(turn);
    return turn;
  };
  const finish = (turn: ClaimedTurn) =>
    store.completeTurn(turn, {
      outcome: "succeeded",
      text: "fixture",
      sessionReusable: true,
    });
  const artifact = (owner: "a" | "b") =>
    media.ingest(
      owner,
      (async function* () {
        yield Buffer.from("fixture");
      })(),
      { displayName: "original.txt" },
    );
  return {
    config,
    media,
    endpoint,
    identity,
    queue,
    claim,
    finish,
    artifact,
    get store() {
      return store;
    },
    get foundation() {
      return foundation;
    },
    reopen() {
      foundation.close();
      foundation = bootstrapFoundation(config);
      store = new HitchStore(foundation.database);
    },
    close() {
      foundation.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Discord historical originals survive reopen but not another owner or new session", async () => {
  const e = environment();
  try {
    const original = await e.artifact("a");
    e.queue("a", [original]);
    e.finish(e.claim("a"));
    e.reopen();
    e.queue("a");
    const resumed = e.claim("a");
    assert.deepEqual(
      resumed.historicalAttachments?.map((r) => r.artifact.id),
      [original.id],
    );
    e.finish(resumed);
    e.queue("b");
    const other = e.claim("b");
    assert.equal(other.historicalAttachments?.length ?? 0, 0);
    e.finish(other);
    const ep = e.endpoint("a");
    e.store.executeCommand(
      e.identity(ep),
      { kind: "new", name: "fresh" },
      "!new fresh",
    );
    e.queue("a");
    const fresh = e.claim("a");
    assert.equal(fresh.historicalAttachments?.length ?? 0, 0);
    e.finish(fresh);
  } finally {
    e.close();
  }
});

test("Discord historical selection excludes future queued and future terminal uploads", async () => {
  const e = environment();
  try {
    const first = e.queue("a");
    const original = await e.artifact("a");
    const future = e.queue("a", [original]);
    // Simulate a later already-terminal record: ordering, not just state, is an ACL boundary.
    e.foundation.database.connection
      .prepare(
        "UPDATE turns SET state='terminal',outcome='succeeded' WHERE id=?",
      )
      .run(future.turnId);
    const earlier = e.claim("a");
    assert.equal(earlier.turnId, first.turnId);
    assert.equal(earlier.historicalAttachments?.length ?? 0, 0);
    e.finish(earlier);
    e.queue("a");
    const after = e.claim("a");
    assert.deepEqual(
      after.historicalAttachments?.map((r) => r.artifact.id),
      [original.id],
    );
    e.finish(after);
    const noFile = e.queue("a");
    const laterFile = await e.artifact("a");
    e.queue("a", [laterFile]);
    const beforeQueued = e.claim("a");
    assert.equal(beforeQueued.turnId, noFile.turnId);
    assert.ok(
      !beforeQueued.historicalAttachments?.some(
        (r) => r.artifact.id === laterFile.id,
      ),
    );
    e.finish(beforeQueued);
  } finally {
    e.close();
  }
});

test("Discord current attachments consume the shared eight-file budget first", async () => {
  const e = environment();
  try {
    const original = await e.artifact("a");
    e.queue("a", [original]);
    e.finish(e.claim("a"));
    const current = await Promise.all(
      Array.from({ length: 8 }, () => e.artifact("a")),
    );
    e.queue("a", current);
    const turn = e.claim("a");
    assert.equal(turn.artifacts?.length, 8);
    assert.equal(turn.historicalAttachments?.length ?? 0, 0);
    e.finish(turn);
  } finally {
    e.close();
  }
});

test("Discord current bytes take priority over historical originals within forty MiB", async () => {
  const e = environment();
  const mib = 1024 * 1024;
  const make = (count: number) =>
    e.media.ingest(
      "a",
      (async function* () {
        const chunk = Buffer.alloc(mib);
        for (let i = 0; i < count; i++) yield chunk;
      })(),
      { displayName: "budget.bin" },
    );
  try {
    const historical = await make(20);
    e.queue("a", [historical]);
    e.finish(e.claim("a"));
    const current = [await make(20), await make(1)];
    e.queue("a", current);
    const turn = e.claim("a");
    assert.equal(turn.artifacts?.length, 2);
    assert.equal(turn.historicalAttachments?.length ?? 0, 0);
    assert.equal(
      turn.artifacts?.reduce((sum, a) => sum + a.bytes, 0),
      21 * mib,
    );
    e.finish(turn);
  } finally {
    e.close();
  }
});
