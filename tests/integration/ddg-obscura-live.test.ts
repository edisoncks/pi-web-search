import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchDuckDuckGoForTool } from "../../lib/duckduckgo.js";
import {
  createDuckDuckGoState,
  DuckDuckGoDriftError,
  DuckDuckGoUnavailableError,
} from "../../lib/policy.js";
import type { NormalizedSearchParams } from "../../lib/types.js";

// A real `obscura` subprocess on PATH drives the DuckDuckGo path end to end:
// spawn, classify, and shape the tool error. The stub prints a chosen fixture,
// so success, challenge, and drift are all exercised without the network.

const posixDescribe = process.platform === "win32" ? describe.skip : describe;

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/ddg/${name}`, import.meta.url));
}

const params: NormalizedSearchParams = {
  query: "hello",
  allowedDomains: [],
  blockedDomains: [],
  numResults: 5,
};

const savedPath = process.env.PATH;
const savedFixture = process.env.FAKE_OBSCURA_FIXTURE;
let binDir = "";

before(async () => {
  binDir = await mkdtemp(join(tmpdir(), "pi-web-search-obscura-"));
  const script = [
    "#!/usr/bin/env node",
    'const { readFileSync } = require("node:fs");',
    "process.stdout.write(",
    '  readFileSync(process.env.FAKE_OBSCURA_FIXTURE, "utf8"),',
    ");",
    "",
  ].join("\n");
  await writeFile(join(binDir, "obscura"), script, "utf8");
  await chmod(join(binDir, "obscura"), 0o755);
  process.env.PATH = `${binDir}:${savedPath ?? ""}`;
});

beforeEach(() => {
  delete process.env.FAKE_OBSCURA_FIXTURE;
});

after(async () => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedFixture === undefined) delete process.env.FAKE_OBSCURA_FIXTURE;
  else process.env.FAKE_OBSCURA_FIXTURE = savedFixture;
  if (binDir) await rm(binDir, { recursive: true, force: true });
});

posixDescribe("DuckDuckGo subprocess boundary (real obscura on PATH)", () => {
  it("spawns obscura and formats the parsed page", async () => {
    process.env.FAKE_OBSCURA_FIXTURE = fixture("lite-results.html");
    const result = await searchDuckDuckGoForTool(
      params,
      createDuckDuckGoState(),
      undefined,
    );
    assert.equal(result.resultCount, 2);
    assert.match(result.text, /provider: DuckDuckGo/);
    assert.match(result.text, /example\.com\/one/);
  });

  it("surfaces a challenge as DuckDuckGoUnavailableError with guidance", async () => {
    process.env.FAKE_OBSCURA_FIXTURE = fixture("challenge.html");
    const state = createDuckDuckGoState();
    await assert.rejects(
      searchDuckDuckGoForTool(params, state, undefined),
      (error: unknown) => {
        assert.ok(error instanceof DuckDuckGoUnavailableError);
        assert.match(error.message, /use web_search_exa for this search/);
        assert.ok(state.unavailableUntil > Date.now());
        return true;
      },
    );
  });

  it("surfaces parser drift as DuckDuckGoDriftError", async () => {
    process.env.FAKE_OBSCURA_FIXTURE = fixture("drift.html");
    await assert.rejects(
      searchDuckDuckGoForTool(params, createDuckDuckGoState(), undefined),
      (error: unknown) => error instanceof DuckDuckGoDriftError,
    );
  });
});
