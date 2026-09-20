import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createDuckDuckGoState,
  getSearchSignal,
  UnsupportedRuntimeError,
} from "../lib/policy.js";
import { searchExaForTool } from "../lib/exa.js";
import { searchDuckDuckGoForTool } from "../lib/duckduckgo.js";
import type { NormalizedSearchParams } from "../lib/types.js";

// Simulate a Node too old for AbortSignal.timeout/any by removing the statics,
// then assert that the guard throws UnsupportedRuntimeError and that neither
// provider wrapper rewrites it into a provider error. The descriptors are
// captured so each static is restored exactly as Node defined it.
const timeoutDescriptor = Object.getOwnPropertyDescriptor(
  AbortSignal,
  "timeout",
);
const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");

afterEach(() => {
  if (timeoutDescriptor) {
    Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
  }
  if (anyDescriptor) {
    Object.defineProperty(AbortSignal, "any", anyDescriptor);
  }
});

function breakAbortStatics(): void {
  Reflect.deleteProperty(AbortSignal, "timeout");
  Reflect.deleteProperty(AbortSignal, "any");
}

const params: NormalizedSearchParams = {
  query: "hello",
  allowedDomains: [],
  blockedDomains: [],
  numResults: 3,
};

describe("unsupported runtime guard", () => {
  it("getSearchSignal throws a typed UnsupportedRuntimeError", () => {
    breakAbortStatics();
    assert.throws(
      () => getSearchSignal(undefined),
      (error: unknown) => error instanceof UnsupportedRuntimeError,
    );
  });

  it("names the Node floor in the message", () => {
    breakAbortStatics();
    assert.throws(
      () => getSearchSignal(undefined),
      /requires Node >=22\.19\.0/,
    );
  });

  it("searchExaForTool surfaces the runtime error unchanged", async () => {
    breakAbortStatics();
    await assert.rejects(
      searchExaForTool(params, undefined),
      (error: unknown) => error instanceof UnsupportedRuntimeError,
    );
  });

  it("searchDuckDuckGoForTool surfaces the runtime error unchanged", async () => {
    breakAbortStatics();
    const state = createDuckDuckGoState();
    await assert.rejects(
      searchDuckDuckGoForTool(params, state, undefined),
      (error: unknown) => error instanceof UnsupportedRuntimeError,
    );
  });
});
