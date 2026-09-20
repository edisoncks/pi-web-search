import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertSupportedRuntime,
  createDuckDuckGoState,
  getSearchSignal,
  UnsupportedRuntimeError,
  type AbortSignalStatics,
} from "../lib/policy.js";
import { searchExaForTool } from "../lib/exa.js";
import { searchDuckDuckGoForTool } from "../lib/duckduckgo.js";
import type { NormalizedSearchParams } from "../lib/types.js";

// A Node too old for `AbortSignal.timeout`/`AbortSignal.any` is simulated by
// injecting broken statics rather than deleting the globals, so the tests never
// mutate shared process state.
const brokenStatics = {} as AbortSignalStatics;

const params: NormalizedSearchParams = {
  query: "hello",
  allowedDomains: [],
  blockedDomains: [],
  numResults: 3,
};

describe("unsupported runtime guard", () => {
  it("assertSupportedRuntime throws a typed UnsupportedRuntimeError", () => {
    assert.throws(
      () => assertSupportedRuntime(brokenStatics),
      (error: unknown) => error instanceof UnsupportedRuntimeError,
    );
  });

  it("names the Node floor in the message", () => {
    assert.throws(
      () => assertSupportedRuntime(brokenStatics),
      /requires Node >=22\.19\.0/,
    );
  });

  it("getSearchSignal surfaces the runtime error", () => {
    assert.throws(
      () => getSearchSignal(undefined, brokenStatics),
      (error: unknown) => error instanceof UnsupportedRuntimeError,
    );
  });

  it("searchExaForTool surfaces the runtime error unchanged", async () => {
    await assert.rejects(
      searchExaForTool(params, undefined, brokenStatics),
      (error: unknown) => error instanceof UnsupportedRuntimeError,
    );
  });

  it("searchDuckDuckGoForTool surfaces the runtime error unchanged", async () => {
    const state = createDuckDuckGoState();
    await assert.rejects(
      searchDuckDuckGoForTool(params, state, undefined, brokenStatics),
      (error: unknown) => error instanceof UnsupportedRuntimeError,
    );
  });
});
