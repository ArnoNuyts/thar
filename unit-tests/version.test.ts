import { expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import {
  compareVersions,
  isNewerVersion,
  parseVersion,
  type ParsedVersion,
} from "../logic/version.ts";

const exact = (version: ParsedVersion) => ({
  major: version.major,
  minor: version.minor,
  patch: version.patch,
  prerelease: version.prerelease,
  build: version.build,
});

test("version: parses full semver values with a v prefix and whitespace", () => {
  expect(exact(parseVersion("1.2.3")!)).toEqual({
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
    build: [],
  });
  expect(exact(parseVersion(" v0.5.0 ")!).major).toEqual(0);
});

test("version: parses prerelease and build metadata", () => {
  const parsed = parseVersion("1.2.3-alpha.1+build.7");
  expect(parsed).toBeDefined();
  expect(parsed?.prerelease).toEqual(["alpha", "1"]);
  expect(parsed?.build).toEqual(["build", "7"]);
});

test("version: rejects invalid input", () => {
  expect(parseVersion("")).toBeUndefined();
  expect(parseVersion("1.2")).toBeUndefined();
  expect(parseVersion("1.2.3.4")).toBeUndefined();
  expect(parseVersion("01.2.3")).toBeUndefined();
  expect(parseVersion("1.2.3-01")).toBeUndefined();
  expect(parseVersion("not-a-version")).toBeUndefined();
  expect(parseVersion("1.2.3-")).toBeUndefined();
});

test("version: compares major, minor and patch numerically", () => {
  expect(compareVersions("1.2.3", "1.2.3")).toEqual(0);
  expect(compareVersions("1.2.4", "1.2.3")).toEqual(1);
  expect(compareVersions("1.2.3", "1.2.4")).toEqual(-1);
  expect(compareVersions("1.10.0", "1.9.9")).toEqual(1);
  expect(compareVersions("2.0.0", "10.0.0")).toEqual(-1);
  expect(compareVersions("v1.0.0", "1.0.0")).toEqual(0);
});

test("version: applies semver prerelease precedence", () => {
  expect(compareVersions("2.0.0-alpha", "2.0.0")).toEqual(-1);
  expect(compareVersions("2.0.0-alpha", "2.0.0-alpha.1")).toEqual(-1);
  expect(compareVersions("2.0.0-alpha.1", "2.0.0-alpha.beta")).toEqual(-1);
  expect(compareVersions("2.0.0-alpha.beta", "2.0.0-beta")).toEqual(-1);
  expect(compareVersions("2.0.0-beta", "2.0.0-beta.2")).toEqual(-1);
  expect(compareVersions("2.0.0-beta.2", "2.0.0-beta.11")).toEqual(-1);
  expect(compareVersions("2.0.0-beta.11", "2.0.0-rc.1")).toEqual(-1);
  expect(compareVersions("2.0.0-rc.1", "2.0.0")).toEqual(-1);
});

test("version: ignores build metadata", () => {
  expect(compareVersions("1.2.3+build.1", "1.2.3+build.2")).toEqual(0);
  expect(compareVersions("1.2.3+1", "1.2.4+1")).toEqual(-1);
});

test("version: returns null when either side is invalid", () => {
  expect(compareVersions("nope", "1.0.0")).toBeNull();
  expect(compareVersions("1.0.0", "nope")).toBeNull();
});

test("version: isNewerVersion only reports strictly newer versions", () => {
  expect(isNewerVersion("0.5.0", "0.4.0")).toEqual(true);
  expect(isNewerVersion("0.4.0", "0.4.0")).toEqual(false);
  expect(isNewerVersion("0.4.9", "0.5.0")).toEqual(false);
  expect(isNewerVersion("0.5.0-beta.1", "0.5.0")).toEqual(false);
  expect(isNewerVersion("0.5.0", "0.5.0-beta.1")).toEqual(true);
});

test("version: the compile-time version matches package.json", () => {
  expect(__APP_VERSION__).toEqual(packageJson.version);
});
