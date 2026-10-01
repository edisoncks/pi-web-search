import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildObscuraFetchArgs,
  fetchPage,
  fetchPageForTool,
  truncatePageContent,
} from "../../lib/fetch.js";
import { createFetchState } from "../../lib/policy.js";
import {
  FETCH_CONCURRENCY,
  FETCH_MAX_PAGE_CHARS,
  type FetchedPage,
} from "../../lib/types.js";

const page = (url: string, content = "body"): FetchedPage => ({
  status: "ok",
  url,
  content,
  truncated: false,
});

describe("fetch behavior: argv and truncation", () => {
  it("builds the obscura fetch argv", () => {
    assert.deepEqual(buildObscuraFetchArgs("https://example.com/x"), [
      "--stealth",
      "fetch",
      "https://example.com/x",
      "--dump",
      "markdown",
      "--quiet",
      "--timeout",
      "30",
    ]);
  });

  it("keeps short content and truncates long content at a code-point boundary", () => {
    assert.deepEqual(truncatePageContent("abc", 3), {
      content: "abc",
      truncated: false,
    });
    assert.deepEqual(truncatePageContent("abcd", 3), {
      content: "abc",
      truncated: true,
    });

    // The musical symbol is a surrogate pair; the cap must not split it.
    const pair = "a".repeat(FETCH_MAX_PAGE_CHARS - 1) + "\u{1D11E}";
    const { content, truncated } = truncatePageContent(
      pair,
      FETCH_MAX_PAGE_CHARS,
    );
    assert.equal(truncated, true);
    assert.equal(content.length, FETCH_MAX_PAGE_CHARS - 1);
    assert.equal(content.at(-1), "a");
  });
});

describe("fetch behavior: cache and dedup", () => {
  it("caches a page so a second call does not fetch it again", async () => {
    const state = createFetchState();
    let calls = 0;
    const attempt = async (url: string) => {
      calls += 1;
      return page(url);
    };

    await fetchPage("https://e.com", state, undefined, attempt);
    await fetchPage("https://e.com", state, undefined, attempt);
    assert.equal(calls, 1);
  });

  it("dedupes concurrent identical fetches into one attempt", async () => {
    const state = createFetchState();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const attempt = async (url: string) => {
      calls += 1;
      await gate;
      return page(url);
    };

    const first = fetchPage("https://e.com", state, undefined, attempt);
    const second = fetchPage("https://e.com", state, undefined, attempt);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(a, b);
  });
});

describe("fetch behavior: results, errors, and the global slot", () => {
  it("returns a successful page with count one", async () => {
    const state = createFetchState();
    const result = await fetchPageForTool(
      { url: "https://ok.com" },
      state,
      undefined,
      async (url) => page(url, "Hello"),
    );
    assert.equal(result.resultCount, 1);
    assert.match(result.text, /URL: https:\/\/ok\.com/);
    assert.match(result.text, /Hello/);
  });

  it("reports a fetch failure in place", async () => {
    const state = createFetchState();
    const result = await fetchPageForTool(
      { url: "https://bad.com" },
      state,
      undefined,
      async () => {
        throw new Error("nope");
      },
    );
    assert.equal(result.resultCount, 0);
    assert.match(result.text, /Failed to fetch page:/);
    assert.match(result.text, /URL: https:\/\/bad\.com/);
    assert.match(result.text, /Error: nope/);
  });

  it("maps an abort-shaped failure to a timeout entry", async () => {
    const state = createFetchState();
    const result = await fetchPageForTool(
      { url: "https://slow.com" },
      state,
      undefined,
      async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      },
    );

    assert.equal(result.resultCount, 0);
    assert.match(result.text, /Error: timed out/);
  });

  // Regression: a caller whose signal is already aborted must not start the
  // shared fetch. Without the entry check the attempt still ran (a wasted
  // Obscura launch holding a global slot) and, when it later failed, left the
  // shared promise without handlers — an unhandledRejection that can kill the
  // host process.
  it("rejects an already-aborted caller without starting the shared fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const state = createFetchState();
    let calls = 0;
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await assert.rejects(
        fetchPageForTool(
          { url: "https://e.com" },
          state,
          controller.signal,
          async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error("boom");
          },
        ),
      );
      // Give the (never-started) attempt time to have failed if it wrongly ran.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.equal(calls, 0);
    assert.equal(rejections.length, 0);
  });

  it("propagates a caller abort instead of reporting an error", async () => {
    const controller = new AbortController();
    const state = createFetchState();
    const pending = fetchPageForTool(
      { url: "https://slow.com" },
      state,
      controller.signal,
      () => new Promise<FetchedPage>(() => {}),
    );

    controller.abort();
    await assert.rejects(pending);
  });

  it("surfaces a missing obscura as a tool error", async () => {
    const state = createFetchState();
    await assert.rejects(
      fetchPageForTool({ url: "https://e.com" }, state, undefined, async () => {
        throw new Error("spawn obscura ENOENT");
      }),
      /obscura not found on PATH/,
    );
  });

  it("starts the shared deadline before waiting for a global slot", async () => {
    const originalTimeout = AbortSignal.timeout;
    const deadlines: AbortController[] = [];
    const releaseAttempts: Array<() => void> = [];
    const started: string[] = [];
    let cleaningUp = false;
    const timeoutReason = () =>
      new DOMException("The operation timed out", "TimeoutError");
    const state = createFetchState();

    AbortSignal.timeout = (() => {
      const controller = new AbortController();
      deadlines.push(controller);
      // If an assertion fails with the old wiring, immediately abort any
      // queued work that starts during cleanup instead of leaving it hanging.
      if (cleaningUp) controller.abort(timeoutReason());
      return controller.signal;
    }) as typeof AbortSignal.timeout;

    const attempt = (url: string, signal: AbortSignal | undefined) => {
      started.push(url);
      return new Promise<FetchedPage>((resolve, reject) => {
        const onAbort = () => reject(signal?.reason);
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        releaseAttempts.push(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve(page(url));
        });
      });
    };

    const pending = Array.from({ length: FETCH_CONCURRENCY + 1 }, (_, i) =>
      fetchPageForTool(
        { url: `https://e.com/queued-${i}` },
        state,
        undefined,
        attempt,
      ),
    );

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(deadlines.length, FETCH_CONCURRENCY + 1);
      assert.equal(started.length, FETCH_CONCURRENCY);

      // The last call is still queued. Its own deadline must remove it without
      // launching Obscura or releasing a slot held by one of the first calls.
      deadlines.at(-1)?.abort(timeoutReason());
      for (const release of releaseAttempts) release();
      const results = await Promise.all(pending);

      assert.equal(started.length, FETCH_CONCURRENCY);
      assert.equal(results.at(-1)?.resultCount, 0);
      assert.match(results.at(-1)?.text ?? "", /Error: timed out/);
      assert.equal(state.active, 0);
      assert.equal(state.waiters.length, 0);
    } finally {
      cleaningUp = true;
      for (const deadline of deadlines) {
        if (!deadline.signal.aborted) deadline.abort(timeoutReason());
      }
      for (const release of releaseAttempts) release();
      await Promise.allSettled(pending);
      AbortSignal.timeout = originalTimeout;
    }
  });

  it("caps concurrent fetches globally across separate calls", async () => {
    const state = createFetchState();
    let active = 0;
    let peak = 0;
    const attempt = async (url: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return page(url);
    };

    const urls = Array.from({ length: 5 }, (_, i) => `https://e.com/${i}`);
    await Promise.all(
      urls.map((url) => fetchPageForTool({ url }, state, undefined, attempt)),
    );
    assert.equal(peak, FETCH_CONCURRENCY);
  });
});
