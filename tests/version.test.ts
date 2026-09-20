import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PACKAGE_VERSION,
  parsePackageVersion,
  readPackageVersion,
  UNKNOWN_PACKAGE_VERSION,
} from "../lib/version.js";

describe("package version resolution", () => {
  it("reads a semver from the shipped manifest, not the fallback", () => {
    assert.notEqual(PACKAGE_VERSION, UNKNOWN_PACKAGE_VERSION);
    assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+/);
  });

  it("parses a version out of manifest text", () => {
    assert.equal(parsePackageVersion('{"version":"1.2.3"}'), "1.2.3");
    assert.equal(parsePackageVersion('{"version":" 1.2.3 "}'), "1.2.3");
  });

  it("rejects a manifest without a usable version", () => {
    assert.equal(parsePackageVersion('{"name":"x"}'), undefined);
    assert.equal(parsePackageVersion('{"version":"  "}'), undefined);
    assert.equal(parsePackageVersion('{"version":123}'), undefined);
  });

  it("rejects malformed manifest JSON", () => {
    assert.equal(parsePackageVersion("{ not json"), undefined);
  });

  it("falls back instead of throwing when the manifest is unreadable", () => {
    assert.equal(
      readPackageVersion(new URL("file:///definitely/missing/package.json")),
      UNKNOWN_PACKAGE_VERSION,
    );
  });
});
