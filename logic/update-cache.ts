import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Runtime, type RuntimePlatform } from "../utils/runtime.ts";

export interface UpdateCache {
  checkedAt?: number;
  latest?: string;
  lastNotified?: string;
  skipped?: string;
  /** Optional negative cache: last failed registry request. */
  failedAt?: number;
}

export interface StateDirOptions {
  platform: RuntimePlatform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const NEGATIVE_CACHE_MS = 60 * 60 * 1000;

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isVersion = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const resolveStateDir = ({
  platform,
  env = {},
  homeDir = homedir(),
}: StateDirOptions): string => {
  const override = env.TODOTUI_STATE_DIR?.trim();
  if (override) return override;

  if (platform === "windows") {
    return join(
      env.LOCALAPPDATA?.trim() || join(homeDir, "AppData", "Local"),
      "todotui",
    );
  }

  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "todotui");
  }

  return join(
    env.XDG_STATE_HOME?.trim() || join(homeDir, ".local", "state"),
    "todotui",
  );
};

export const getUpdateCachePath = (options: StateDirOptions): string =>
  join(resolveStateDir(options), "update-check.json");

const sanitizeCache = (value: unknown): UpdateCache => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const record = value as Record<string, unknown>;
  const cache: UpdateCache = {};

  if (isTimestamp(record.checkedAt)) cache.checkedAt = record.checkedAt;
  if (isTimestamp(record.failedAt)) cache.failedAt = record.failedAt;
  if (isVersion(record.latest)) cache.latest = record.latest;
  if (isVersion(record.lastNotified)) cache.lastNotified = record.lastNotified;
  if (isVersion(record.skipped)) cache.skipped = record.skipped;

  return cache;
};

export const readUpdateCache = async (path: string): Promise<UpdateCache> => {
  try {
    const contents = await Runtime.readTextFile(path);
    return sanitizeCache(JSON.parse(contents));
  } catch {
    // Missing, unreadable and malformed caches are all equivalent to "no
    // cache". Background checks must never throw into the UI.
    return {};
  }
};

export const writeUpdateCache = async (
  path: string,
  cache: UpdateCache,
): Promise<boolean> => {
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;

  try {
    await Runtime.mkdir(dirname(path), { recursive: true });
    await Runtime.writeTextFile(
      temporary,
      `${JSON.stringify(cache, null, 2)}\n`,
    );
    await Runtime.rename(temporary, path);
    return true;
  } catch {
    try {
      await Runtime.remove(temporary, { recursive: false });
    } catch {
      // Best-effort cleanup; the write already failed.
    }
    return false;
  }
};

export const isCacheFresh = (
  cache: UpdateCache,
  now: number,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
): boolean =>
  typeof cache.checkedAt === "number" &&
  (cache.checkedAt > now || now - cache.checkedAt < intervalMs);

export const isNegativeCacheFresh = (
  cache: UpdateCache,
  now: number,
  intervalMs = NEGATIVE_CACHE_MS,
): boolean =>
  typeof cache.failedAt === "number" &&
  (cache.failedAt > now || now - cache.failedAt < intervalMs);

export const isVersionSkipped = (
  cache: UpdateCache,
  latest: string | undefined,
): boolean => Boolean(latest && cache.skipped === latest);
