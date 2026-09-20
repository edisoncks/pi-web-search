import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDuckDuckGoResultUrl,
  classifyDuckDuckGoResponse,
} from "../lib/duckduckgo.js";

describe("resolveDuckDuckGoResultUrl drops DDG self-links", () => {
  it("drops internal links without a uddg target", () => {
    assert.equal(resolveDuckDuckGoResultUrl("/l/?kh=-1"), undefined);
    assert.equal(
      resolveDuckDuckGoResultUrl("https://duckduckgo.com/l/?kh=-1"),
      undefined,
    );
  });

  it("decodes valid uddg redirect targets", () => {
    assert.equal(
      resolveDuckDuckGoResultUrl(
        "/l/?kh=-1&uddg=https%3A%2F%2Fexample.com%2Fa",
      ),
      "https://example.com/a",
    );
  });

  it("preserves direct external hrefs", () => {
    assert.equal(
      resolveDuckDuckGoResultUrl("https://example.com/direct"),
      "https://example.com/direct",
    );
  });

  it("rejects javascript: and DDG-hosted uddg targets", () => {
    assert.equal(
      resolveDuckDuckGoResultUrl("/l/?uddg=javascript%3Aalert(1)"),
      undefined,
    );
    assert.equal(
      resolveDuckDuckGoResultUrl(
        "/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fl%2F%3Fkh%3D-1",
      ),
      undefined,
    );
  });

  it("keeps hosts that merely end in duckduckgo.com", () => {
    assert.equal(
      resolveDuckDuckGoResultUrl("https://notduckduckgo.com/x"),
      "https://notduckduckgo.com/x",
    );
    assert.equal(
      resolveDuckDuckGoResultUrl(
        "/l/?uddg=https%3A%2F%2Fnotduckduckgo.com%2Fx",
      ),
      "https://notduckduckgo.com/x",
    );
  });

  it("drops duckduckgo.com and its subdomains", () => {
    assert.equal(
      resolveDuckDuckGoResultUrl("https://duckduckgo.com/x"),
      undefined,
    );
    assert.equal(
      resolveDuckDuckGoResultUrl("https://sub.duckduckgo.com/x"),
      undefined,
    );
  });
});

describe("classification keeps DDG self-links out of results", () => {
  it("skips result-link anchors without uddg instead of surfacing DDG URLs", () => {
    const html = [
      '<a class="result-link" href="/l/?kh=-1">Nav junk</a>',
      '<td class="result-snippet">should not appear</td>',
      '<a class="result-link" href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.com%2Freal">Real</a>',
      '<td class="result-snippet">real snippet</td>',
    ].join("\n");
    const classification = classifyDuckDuckGoResponse(html);
    assert.equal(classification.kind, "results");
    if (classification.kind !== "results") throw new Error("expected results");
    const results = classification.results;
    assert.equal(results.length, 1);
    assert.equal(results[0]?.url, "https://example.com/real");
    assert.ok(
      results.every((r) => !r.url.includes("duckduckgo.com")),
      "no DDG self-URLs",
    );
  });
});
