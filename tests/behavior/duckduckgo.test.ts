import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as impl from "../../lib/duckduckgo.js";
import { readFixture } from "./helpers.js";

/** Run the production classifier and return its results, or fail the test. */
function parseResults(
  html: string,
  allowedDomains: string[] = [],
  blockedDomains: string[] = [],
) {
  const classification = impl.classifyDuckDuckGoResponse(
    html,
    allowedDomains,
    blockedDomains,
  );
  if (classification.kind !== "results") {
    throw new Error(`expected results, got ${classification.kind}`);
  }
  return classification.results;
}

describe("DuckDuckGo behavior: parsing and classification", () => {
  it("parses result links and snippets", async () => {
    const html = await readFixture("ddg", "lite-results.html");
    const results = parseResults(html);
    assert.deepEqual(results, [
      {
        title: "Example One",
        url: "https://example.com/one",
        snippet: "First snippet",
      },
      {
        title: "Direct Two",
        url: "https://direct.example.org/two",
        snippet: "Second & snippet",
      },
    ]);
  });

  it("decodes known entities and leaves unknown ones untouched", async () => {
    const html = await readFixture("ddg", "entities.html");
    const results = parseResults(html);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Tom & Jerry \u2014 caf&eacute; \u2014");
    assert.equal(results[0].snippet, "5 < 10 && 10 > 5");
  });

  it("drops DDG self-links and non-http targets", async () => {
    const html = await readFixture("ddg", "selflink.html");
    const results = parseResults(html);
    assert.equal(results.length, 1);
    assert.equal(results[0].url, "https://real.example.com/page");
    assert.ok(results.every((r) => !r.url.includes("duckduckgo.com")));
  });

  it("classifies challenge, drift, and empty", async () => {
    assert.equal(
      impl.classifyDuckDuckGoResponse(
        await readFixture("ddg", "challenge.html"),
      ).kind,
      "challenge",
    );
    assert.equal(
      impl.classifyDuckDuckGoResponse(await readFixture("ddg", "drift.html"))
        .kind,
      "drift",
    );
    assert.equal(
      impl.classifyDuckDuckGoResponse(await readFixture("ddg", "empty.html"))
        .kind,
      "empty",
    );
  });

  it("filters client-side by allowed and blocked domains", async () => {
    const html = await readFixture("ddg", "lite-results.html");
    const blocked = parseResults(html, [], ["example.com"]);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].url, "https://direct.example.org/two");

    const allowed = parseResults(html, ["example.com"], []);
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0].url, "https://example.com/one");
  });

  it("treats results removed by domain filters as empty, not drift", async () => {
    const html = await readFixture("ddg", "lite-results.html");

    // The page has two parseable results; the filters remove both. That is a
    // successful empty result set, never a parser-drift failure.
    const blocked = impl.classifyDuckDuckGoResponse(
      html,
      [],
      ["example.com", "example.org"],
    );
    assert.equal(blocked.kind, "results");
    if (blocked.kind !== "results") throw new Error("expected results");
    assert.deepEqual(blocked.results, []);

    const notAllowed = impl.classifyDuckDuckGoResponse(
      html,
      ["nomatch.test"],
      [],
    );
    assert.equal(notAllowed.kind, "results");
    if (notAllowed.kind !== "results") throw new Error("expected results");
    assert.deepEqual(notAllowed.results, []);
  });
});
