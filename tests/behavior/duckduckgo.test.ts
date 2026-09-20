import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as impl from "../../index.js";
import { readFixture } from "./helpers.js";

describe("DuckDuckGo behavior: parsing and classification", () => {
  it("parses result links and snippets", async () => {
    const html = await readFixture("ddg", "lite-results.html");
    const results = impl.parseDuckDuckGoResults(html) as any[];
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
    const results = impl.parseDuckDuckGoResults(html) as any[];
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Tom & Jerry \u2014 caf&eacute; \u2014");
    assert.equal(results[0].snippet, "5 < 10 && 10 > 5");
  });

  it("drops DDG self-links and non-http targets", async () => {
    const html = await readFixture("ddg", "selflink.html");
    const results = impl.parseDuckDuckGoResults(html) as any[];
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
    const blocked = impl.parseDuckDuckGoResults(html, [], [
      "example.com",
    ]) as any[];
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].url, "https://direct.example.org/two");

    const allowed = impl.parseDuckDuckGoResults(html, [
      "example.com",
    ], []) as any[];
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0].url, "https://example.com/one");
  });
});
