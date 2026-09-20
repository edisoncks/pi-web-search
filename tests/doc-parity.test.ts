import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_NUM_RESULTS,
  MAX_NUM_RESULTS,
  MIN_QUERY_LENGTH,
  REQUEST_TIMEOUT_MS,
} from "../lib/types.js";
import {
  DDG_CACHE_MAX_ENTRIES,
  DDG_CACHE_TTL_MS,
  DDG_COOLDOWN_MS,
  DDG_JITTER_MS,
  DDG_MAX_COOLDOWN_MS,
  DDG_MIN_PAUSE_MS,
} from "../lib/policy.js";
import { EXA_MCP_URL } from "../lib/exa.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

const specText = await readFile(
  new URL("../docs/SPECIFICATION.md", import.meta.url),
  "utf8",
);

function extractSpecConstants(text: string): Record<string, unknown> {
  const match = text.match(/```json spec-constants\n([\s\S]*?)```/);
  assert.ok(match, "SPEC must contain a ```json spec-constants block");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

const actual: Record<string, unknown> = {
  DEFAULT_NUM_RESULTS,
  MAX_NUM_RESULTS,
  MIN_QUERY_LENGTH,
  REQUEST_TIMEOUT_MS,
  DDG_MIN_PAUSE_MS,
  DDG_JITTER_MS,
  DDG_CACHE_TTL_MS,
  DDG_CACHE_MAX_ENTRIES,
  DDG_COOLDOWN_MS,
  DDG_MAX_COOLDOWN_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  EXA_MCP_URL,
};

describe("SPEC constant parity (non-rot guard)", () => {
  const spec = extractSpecConstants(specText);

  for (const [key, value] of Object.entries(actual)) {
    it(`${key} in the SPEC matches the code`, () => {
      assert.ok(key in spec, `SPEC constants block is missing ${key}`);
      assert.deepEqual(spec[key], value, `${key} drifted from the SPEC`);
    });
  }
});
