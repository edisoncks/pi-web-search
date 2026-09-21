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

// The pure guard takes its statics as an argument, so a Node too old for
// `AbortSignal.timeout`/`AbortSignal.any` is simulated by injecting broken
// statics instead of mutating shared process state.
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

  // The provider wrappers read the real `AbortSignal` global, so there is no
  // seam to inject. Break the global for the duration of this one test and
  // restore it unconditionally: nothing between the break and the restore can
  // throw uncaught, and preconditions are created before the break.
  it("both provider wrappers surface the runtime error unchanged", async () => {
    const timeout = AbortSignal.timeout;
    const any = AbortSignal.any;
    const state = createDuckDuckGoState();
    try {
      AbortSignal.timeout = undefined as unknown as typeof AbortSignal.timeout;
      AbortSignal.any = undefined as unknown as typeof AbortSignal.any;

      await assert.rejects(
        searchExaForTool(params, undefined),
        (error: unknown) => error instanceof UnsupportedRuntimeError,
      );
      await assert.rejects(
        searchDuckDuckGoForTool(params, state, undefined),
        (error: unknown) => error instanceof UnsupportedRuntimeError,
      );
    } finally {
      AbortSignal.timeout = timeout;
      AbortSignal.any = any;
    }
  });
});
