import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildObscuraFetchArgs,
  fetchPage,
  fetchPagesForTool,
  truncatePageContent,
} from "../../lib/fetch.js";
import { createFetchState } from "../../lib/policy.js";
import {
  FETCH_CONCURRENCY,
  FETCH_MAX_PAGE_CHARS,
  type FetchedPage,
} from "../../lib/types.js";

const params = (urls: string[]) => ({ urls });

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

describe("fetch behavior: batch", () => {
  it("reports a per-URL error and still formats the successes", async () => {
    const state = createFetchState();
    const result = await fetchPagesForTool(
      params(["https://ok.com", "https://bad.com"]),
      state,
      undefined,
      async (url) => {
        if (url === "https://bad.com") throw new Error("nope");
        return page(url, "OK");
      },
    );

    assert.equal(result.resultCount, 1);
    assert.match(result.text, /1\. https:\/\/ok\.com\nOK/);
    assert.match(result.text, /2\. https:\/\/bad\.com\n {3}Error: nope/);
  });

  it("maps an abort-shaped failure to a timeout entry", async () => {
    const state = createFetchState();
    const result = await fetchPagesForTool(
      params(["https://slow.com"]),
      state,
      undefined,
      async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      },
    );

    assert.equal(result.resultCount, 0);
    assert.match(result.text, /Error: timed out/);
  });

  it("propagates a caller abort instead of reporting a per-URL error", async () => {
    const controller = new AbortController();
    const state = createFetchState();
    const pending = fetchPagesForTool(
      params(["https://slow.com"]),
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
      fetchPagesForTool(
        params(["https://e.com"]),
        state,
        undefined,
        async () => {
          throw new Error("spawn obscura ENOENT");
        },
      ),
      /obscura not found on PATH/,
    );
  });

  it("caps the number of concurrent attempts", async () => {
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
    await fetchPagesForTool(params(urls), state, undefined, attempt);
    assert.equal(peak, FETCH_CONCURRENCY);
  });
});
