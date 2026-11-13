import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  getUpdateCachePath,
  isCacheFresh,
  isNegativeCacheFresh,
  isVersionSkipped,
  mutateUpdateCache,
  NEGATIVE_CACHE_MS,
  readUpdateCache,
  resolveStateDir,
  UPDATE_CHECK_INTERVAL_MS,
  writeUpdateCache,
} from "../logic/update-cache.ts";
import { Runtime } from "../utils/runtime.ts";

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await Runtime.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Runtime.remove(dir, { recursive: true });
  }
};

test("update-cache: resolves the Linux state directory", () => {
  expect(
    resolveStateDir({
      platform: "linux",
      env: { XDG_STATE_HOME: "/tmp/state" },
      homeDir: "/home/me",
    }),
  ).toEqual(join("/tmp/state", "thar"));
  expect(
    resolveStateDir({ platform: "linux", env: {}, homeDir: "/home/me" }),
  ).toEqual(join("/home/me", ".local", "state", "thar"));
});

test("update-cache: resolves the macOS state directory", () => {
  expect(
    resolveStateDir({ platform: "darwin", env: {}, homeDir: "/Users/me" }),
  ).toEqual(join("/Users/me", "Library", "Application Support", "thar"));
});

test("update-cache: resolves the Windows state directory", () => {
  expect(
    resolveStateDir({
      platform: "windows",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      homeDir: "C:\\Users\\me",
    }),
  ).toEqual(join("C:\\Users\\me\\AppData\\Local", "thar"));
});

test("update-cache: THAR_STATE_DIR overrides every platform", () => {
  expect(
    resolveStateDir({
      platform: "darwin",
      env: { THAR_STATE_DIR: "/tmp/thar-state" },
      homeDir: "/Users/me",
    }),
  ).toEqual("/tmp/thar-state");
  expect(
    getUpdateCachePath({
      platform: "linux",
      env: { THAR_STATE_DIR: "/tmp/thar-state" },
      homeDir: "/home/me",
    }),
  ).toEqual(join("/tmp/thar-state", "update-check.json"));
});

test("update-cache: missing and corrupt files behave like an empty cache", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "update-check.json");

    expect(await readUpdateCache(path)).toEqual({});

    await writeFile(path, "{ not json", "utf8");
    expect(await readUpdateCache(path)).toEqual({});

    await writeFile(
      path,
      JSON.stringify({ latest: 42, checkedAt: "soon" }),
      "utf8",
    );
    expect(await readUpdateCache(path)).toEqual({});
  });
});

test("update-cache: writes atomically and round-trips valid fields", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "nested", "update-check.json");
    const cache = {
      checkedAt: 123,
      latest: "0.5.0",
      lastNotified: "0.5.0",
      skipped: "0.4.9",
    };

    expect(await writeUpdateCache(path, cache)).toEqual(true);

    expect(await readUpdateCache(path)).toEqual(cache);

    const entries = await readdir(join(dir, "nested"));
    expect(entries).toEqual(["update-check.json"]);

    expect(await writeUpdateCache(path, { ...cache, latest: "0.6.0" })).toEqual(
      true,
    );
    expect((await readUpdateCache(path)).latest).toEqual("0.6.0");
    expect(await readdir(join(dir, "nested"))).toEqual(["update-check.json"]);
  });
});

test("update-cache: write failures are reported without throwing", async () => {
  await withTempDir(async (dir) => {
    const parent = join(dir, "not-a-directory");
    await writeFile(parent, "file", "utf8");

    expect(await writeUpdateCache(join(parent, "cache.json"), {})).toEqual(
      false,
    );
  });
});

test("update-cache: TTL is strict at the boundary", () => {
  const now = 1_000_000_000_000;
  expect(
    isCacheFresh({ checkedAt: now - UPDATE_CHECK_INTERVAL_MS + 1 }, now),
  ).toEqual(true);
  expect(
    isCacheFresh({ checkedAt: now - UPDATE_CHECK_INTERVAL_MS }, now),
  ).toEqual(false);
  expect(
    isCacheFresh({ checkedAt: now - UPDATE_CHECK_INTERVAL_MS - 1 }, now),
  ).toEqual(false);
  expect(isCacheFresh({}, now)).toEqual(false);
  expect(isCacheFresh({ checkedAt: now + 1_000 }, now)).toEqual(true);
});

test("update-cache: negative cache is strict at the boundary", () => {
  const now = 1_000_000_000_000;
  expect(
    isNegativeCacheFresh({ failedAt: now - NEGATIVE_CACHE_MS + 1 }, now),
  ).toEqual(true);
  expect(
    isNegativeCacheFresh({ failedAt: now - NEGATIVE_CACHE_MS }, now),
  ).toEqual(false);
  expect(isNegativeCacheFresh({}, now)).toEqual(false);
});

test("update-cache: serializes concurrent mutations without losing fields", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "update-check.json");
    await writeUpdateCache(path, { latest: "0.5.0" });

    await Promise.all([
      mutateUpdateCache(path, (cache) => ({
        ...cache,
        lastNotified: "0.5.0",
      })),
      mutateUpdateCache(path, (cache) => ({
        ...cache,
        skipped: "0.5.0",
      })),
    ]);

    const cache = await readUpdateCache(path);
    expect(cache.latest).toEqual("0.5.0");
    expect(cache.lastNotified).toEqual("0.5.0");
    expect(cache.skipped).toEqual("0.5.0");
  });
});

test("update-cache: skip matching is version-specific", () => {
  expect(isVersionSkipped({ skipped: "0.5.0" }, "0.5.0")).toEqual(true);
  expect(isVersionSkipped({ skipped: "0.5.0" }, "0.5.1")).toEqual(false);
  expect(isVersionSkipped({}, "0.5.0")).toEqual(false);
  expect(isVersionSkipped({ skipped: "0.5.0" }, undefined)).toEqual(false);
});
