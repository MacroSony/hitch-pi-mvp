import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Bounded wording-only guard. The mandatory sandbox extension lives outside
// the repository's tsc project and needs a live Bubblewrap/systemd host to
// import, so this test asserts the exact source strings that build the
// registered tool descriptions and JSON path schemas. Host-only acceptance
// tests still exercise real registration; this only prevents guidance drift.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(
  join(repository, "packages", "hitch-sandbox-extension", "hitch-sandbox.ts"),
  "utf8",
);

const allTools = [
  "read",
  "write",
  "edit",
  "ls",
  "grep",
  "find",
  "bash",
  "hitch_publish",
];
const pathBearingTools = allTools.filter((name) => name !== "bash");

function sourceBlock(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end >= 0, `missing ${endMarker}`);
  return source.slice(start, end);
}

function unescapeSourceString(value: string): string {
  return value.replaceAll('\\"', '"');
}

function stringEntries(block: string, pattern: RegExp): Map<string, string> {
  return new Map(
    [...block.matchAll(pattern)].map((match) => [
      match[1]!,
      unescapeSourceString(match[2]!),
    ]),
  );
}

const definitions = stringEntries(
  sourceBlock("const definitions = [", "] as const;"),
  /^\t+\["([a-z_]+)",\s*"((?:[^"\\]|\\.)*)"\],$/gmu,
);
const pathDescriptions = stringEntries(
  sourceBlock("const pathDescriptions = {", "} as const;"),
  /^\t([a-z_]+): "((?:[^"\\]|\\.)*)",$/gmu,
);

test("sandbox tool descriptions require relative workspace paths", () => {
  assert.deepEqual([...definitions.keys()].sort(), allTools.slice().sort());
  assert.deepEqual(
    [...pathDescriptions.keys()].sort(),
    pathBearingTools.slice().sort(),
  );
  assert.equal(
    [...source.matchAll(/\t\["([a-z_]+)",/gu)].length,
    allTools.length,
    "build-sandbox.mjs static-tool extractor input stays intact",
  );

  for (const name of pathBearingTools) {
    const description = definitions.get(name);
    assert.ok(description, `${name} description`);
    assert.ok(
      description.toLowerCase().includes("workspace-relative"),
      `${name} tells the model to use a workspace-relative path`,
    );
    assert.ok(
      description.includes("traversal"),
      `${name} keeps traversal rejection visible`,
    );
    assert.ok(
      description.includes("never prefix it with /workspace/ or ./"),
      `${name} rejects /workspace/ and ./ prefixes`,
    );
  }

  for (const name of ["read", "ls", "grep", "find"] as const) {
    assert.ok(
      definitions.get(name)?.includes("/inbox/"),
      `${name} documents the read-only /inbox exception`,
    );
  }
  for (const name of ["write", "edit"] as const) {
    assert.ok(
      !definitions.get(name)?.includes("/inbox/"),
      `${name} does not imply inbox access`,
    );
  }
  for (const name of ["ls", "grep", "find"] as const) {
    assert.ok(
      definitions
        .get(name)
        ?.includes('omit it or pass "." for the workspace root'),
      `${name} keeps omitted-or-dot workspace-root behavior`,
    );
  }

  assert.ok(
    pathDescriptions.get("grep")?.includes("Workspace-relative directory"),
    "grep's backend walks a directory, not an individual file",
  );

  const publish = definitions.get("hitch_publish");
  assert.ok(
    publish?.includes('hitch_publish({"path":"pelican-on-bike.svg"})'),
    "hitch_publish shows the relative publication example",
  );
  assert.ok(
    publish?.includes("Turn completes") && publish.includes("queues delivery"),
    "hitch_publish does not promise confirmation before Turn completion",
  );
  assert.ok(
    publish?.includes("do not tell the user"),
    "hitch_publish tells the model not to promise delivery",
  );
  assert.ok(
    publish?.includes("open /workspace"),
    "hitch_publish tells the model not to point the IM user at /workspace",
  );

  const bash = definitions.get("bash");
  assert.ok(
    bash?.includes("cwd /workspace") && bash.includes("absolute"),
    "bash explains that its cwd is /workspace",
  );
  assert.ok(
    bash?.includes("/workspace/report.pdf") &&
      bash.includes("file-tool path arguments"),
    "bash distinguishes command paths from file-tool path arguments",
  );
});

test("sandbox path schemas carry guidance without changing their shape", () => {
  for (const name of pathBearingTools) {
    const description = pathDescriptions.get(name);
    assert.ok(description, `${name} path description`);
    assert.ok(
      description.includes("Workspace-relative"),
      `${name} path schema has relative guidance`,
    );
    assert.ok(
      description.includes("Never prefix it with /workspace/ or ./"),
      `${name} path schema rejects /workspace/ and ./ prefixes`,
    );
    assert.ok(
      description.includes("traversal is rejected"),
      `${name} path schema keeps traversal rejection visible`,
    );
  }

  for (const name of ["read", "ls", "grep", "find"] as const) {
    assert.ok(
      pathDescriptions.get(name)?.includes("/inbox/"),
      `${name} path schema documents read-only /inbox`,
    );
  }
  for (const name of ["write", "edit"] as const) {
    assert.ok(
      !pathDescriptions.get(name)?.includes("/inbox/"),
      `${name} path schema does not imply inbox access`,
    );
  }
  for (const name of ["ls", "grep", "find"] as const) {
    assert.ok(
      pathDescriptions.get(name)?.includes('pass "." for the workspace root'),
      `${name} path schema keeps omitted-or-dot workspace-root behavior`,
    );
  }
  assert.ok(
    pathDescriptions.get("hitch_publish")?.includes("pelican-on-bike.svg") &&
      pathDescriptions.get("hitch_publish")?.includes("Turn completes"),
    "hitch_publish path schema carries the example and delivery timing",
  );

  for (const name of ["read", "write", "edit", "hitch_publish"] as const) {
    assert.ok(
      source.includes(`path: pathType(pathDescriptions.${name})`),
      `${name} schema path is wired to its description`,
    );
  }
  for (const name of ["ls", "grep", "find"] as const) {
    assert.ok(
      source.includes(
        `path: Type.Optional(pathType(pathDescriptions.${name}))`,
      ),
      `${name} schema path keeps its optional shape and description`,
    );
  }
  assert.ok(
    source.includes("minLength: 1, maxLength: 4096, description"),
    "path schemas keep the original string bounds and add only a description",
  );
});
