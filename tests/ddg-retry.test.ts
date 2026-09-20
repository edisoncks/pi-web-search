import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDuckDuckGoState,
  withDuckDuckGoRequestSlot,
  isRetryableDuckDuckGoError,
  DuckDuckGoDriftError,
  DuckDuckGoUnavailableError,
} from "../index.js";

describe("isRetryableDuckDuckGoError (P4: typed retry)", () => {
  it("does not retry circuit-open, drift, or abort", () => {
    assert.equal(
      isRetryableDuckDuckGoError(
        new DuckDuckGoUnavailableError("busy", Date.now() + 1000),
      ),
      false,
    );
    assert.equal(
      isRetryableDuckDuckGoError(new DuckDuckGoDriftError("drift")),
      false,
    );
    assert.equal(
      isRetryableDuckDuckGoError(new DOMException("aborted", "AbortError")),
      false,
    );
  });

  it("retries transient I/O failures", () => {
    assert.equal(
      isRetryableDuckDuckGoError(new Error("spawn obscura ETIMEDOUT")),
      true,
    );
    assert.equal(isRetryableDuckDuckGoError(new Error("fetch failed")), true);
    assert.equal(
      isRetryableDuckDuckGoError(
        new Error("Obscura returned empty DuckDuckGo HTML"),
      ),
      true,
    );
  });
});

describe("withDuckDuckGoRequestSlot spacing (P4: success-only penalty)", () => {
  it("does not advance nextRequestAt on deterministic failure, releases queue", async () => {
    const state = createDuckDuckGoState();
    await assert.rejects(
      withDuckDuckGoRequestSlot(state, undefined, () => {
        throw new DuckDuckGoDriftError("markup changed");
      }),
      /markup changed/,
    );
    assert.equal(state.nextRequestAt, 0);
    // Queue released: a later success still runs.
    const out = await withDuckDuckGoRequestSlot(
      state,
      undefined,
      async () => "ok",
    );
    assert.equal(out, "ok");
  });

  it("does not let an aborted waiter free the slot before the holder finishes", async () => {
    const state = createDuckDuckGoState();
    const order: string[] = [];
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const controller = new AbortController();

    const holder = withDuckDuckGoRequestSlot(state, undefined, async () => {
      order.push("holder:start");
      await holderGate;
      order.push("holder:end");
      throw new DuckDuckGoDriftError("deterministic");
    });
    const aborted = withDuckDuckGoRequestSlot(
      state,
      controller.signal,
      async () => {
        order.push("aborted:start");
      },
    );

    controller.abort();
    await assert.rejects(aborted);

    const next = withDuckDuckGoRequestSlot(state, undefined, async () => {
      order.push("next:start");
      order.push("next:end");
    });

    // The next waiter must stay blocked while the holder is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ["holder:start"]);

    releaseHolder();
    await assert.rejects(holder, /deterministic/);
    await next;
    assert.deepEqual(order, [
      "holder:start",
      "holder:end",
      "next:start",
      "next:end",
    ]);
  });

  it("advances nextRequestAt on success", async () => {
    const state = createDuckDuckGoState();
    const before = Date.now();
    await withDuckDuckGoRequestSlot(state, undefined, async () => "ok");
    assert.ok(
      state.nextRequestAt >= before + 2500,
      `nextRequestAt=${state.nextRequestAt}`,
    );
    assert.ok(
      state.nextRequestAt <= Date.now() + 5000,
      `nextRequestAt=${state.nextRequestAt}`,
    );
  });
});
