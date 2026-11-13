import {
  getUpdateCachePath,
  isCacheFresh,
  isNegativeCacheFresh,
  isVersionSkipped,
  NEGATIVE_CACHE_MS,
  readUpdateCache,
  UPDATE_CHECK_INTERVAL_MS,
  writeUpdateCache,
  type UpdateCache,
} from "./update-cache.ts";
import { PACKAGE_NAME } from "./package.ts";
import { isNewerVersion, parseVersion } from "./version.ts";
import { Runtime } from "../utils/runtime.ts";

export const DEFAULT_REGISTRY_BASE = "https://registry.npmjs.org";
export const UPDATE_TIMEOUT_MS = 1_500;
export const MAX_RESPONSE_BYTES = 64 * 1024;

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type UpdateFailureReason =
  | "http"
  | "network"
  | "timeout"
  | "invalid"
  | "too-large";

export type CheckOutcome =
  | {
      status: "update-available" | "up-to-date";
      current: string;
      latest: string;
    }
  | {
      status: "error";
      current: string;
      reason: UpdateFailureReason;
    };

const readEnv = (env: NodeJS.ProcessEnv | undefined) => env ?? process.env;

const isEnabledMarker = (value: string | undefined): boolean =>
  Boolean(value) && value !== "0" && value?.toLowerCase() !== "false";

export const resolveRegistryBase = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const configured = env.TODOTUI_REGISTRY?.trim()
    ? env.TODOTUI_REGISTRY.trim()
    : env.npm_config_registry?.trim();

  return (configured || DEFAULT_REGISTRY_BASE).replace(/\/+$/, "");
};

export const buildLatestManifestUrl = (
  registryBase: string = DEFAULT_REGISTRY_BASE,
): string =>
  `${registryBase.replace(/\/+$/, "")}/${encodeURIComponent(PACKAGE_NAME)}/latest`;

export interface UpdateGateOptions {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  argv?: readonly string[];
}

export const shouldCheckForUpdates = ({
  env,
  isTTY = Boolean(process.stdout.isTTY),
  argv = [],
}: UpdateGateOptions = {}): boolean => {
  const environment = readEnv(env);

  if (argv.includes("--no-update-check")) return false;
  if (!isTTY) return false;

  if (isEnabledMarker(environment.CI)) return false;
  // `npx` sets npm_lifecycle_event to an exec marker; that is a normal CLI
  // invocation, not an npm lifecycle script.
  const lifecycle = environment.npm_lifecycle_event;
  if (
    isEnabledMarker(lifecycle) &&
    lifecycle !== "npx" &&
    lifecycle !== "exec"
  ) {
    return false;
  }
  if (isEnabledMarker(environment.VITEST)) return false;
  if (environment.NODE_ENV === "test") return false;

  if (isEnabledMarker(environment.TODOTUI_NO_UPDATE_CHECK)) return false;
  if (isEnabledMarker(environment.NO_UPDATE_NOTIFIER)) return false;

  return true;
};

export interface CheckForUpdateOptions {
  currentVersion: string;
  fetchImpl?: FetchLike;
  registryBase?: string;
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readContentLength = (response: Response): number | undefined => {
  const header = response.headers?.get("content-length");
  if (!header) return undefined;
  const parsed = Number(header);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const checkForUpdate = async ({
  currentVersion,
  fetchImpl = fetch,
  registryBase = resolveRegistryBase(),
  timeoutMs = UPDATE_TIMEOUT_MS,
}: CheckForUpdateOptions): Promise<CheckOutcome> => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  Runtime.unrefTimer(timer);

  try {
    const response = await fetchImpl(buildLatestManifestUrl(registryBase), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": `thar/${currentVersion}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { status: "error", current: currentVersion, reason: "http" };
    }

    const declaredLength = readContentLength(response);
    if (declaredLength !== undefined && declaredLength > MAX_RESPONSE_BYTES) {
      return {
        status: "error",
        current: currentVersion,
        reason: "too-large",
      };
    }

    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      return {
        status: "error",
        current: currentVersion,
        reason: "too-large",
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return { status: "error", current: currentVersion, reason: "invalid" };
    }

    if (!isRecord(payload) || typeof payload.version !== "string") {
      return { status: "error", current: currentVersion, reason: "invalid" };
    }

    if (!parseVersion(payload.version)) {
      return { status: "error", current: currentVersion, reason: "invalid" };
    }

    return {
      status: isNewerVersion(payload.version, currentVersion)
        ? "update-available"
        : "up-to-date",
      current: currentVersion,
      latest: payload.version,
    };
  } catch (error) {
    const aborted =
      timedOut ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"));
    return {
      status: "error",
      current: currentVersion,
      reason: aborted ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timer);
  }
};

export interface RunUpdateCheckOptions {
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  argv?: readonly string[];
  now?: () => number;
  fetchImpl?: FetchLike;
  cachePath?: string;
  registryBase?: string;
  timeoutMs?: number;
  intervalMs?: number;
  negativeCacheMs?: number;
  force?: boolean;
  platform?: "windows" | "darwin" | "linux";
  homeDir?: string;
  readCache?: (path: string) => Promise<UpdateCache>;
  writeCache?: (path: string, cache: UpdateCache) => Promise<boolean>;
}

export interface RunUpdateCheckResult {
  status: "disabled" | "cached" | "checked" | "failed";
  updateAvailable: boolean;
  latest?: string;
  cache: UpdateCache;
  skipped: boolean;
  reason?: UpdateFailureReason | "negative-cache";
}

const availableFor = (cache: UpdateCache, currentVersion: string): boolean =>
  Boolean(cache.latest) &&
  isNewerVersion(cache.latest as string, currentVersion) &&
  !isVersionSkipped(cache, cache.latest);

export const runUpdateCheck = async (
  options: RunUpdateCheckOptions,
): Promise<RunUpdateCheckResult> => {
  const env = readEnv(options.env);
  const now = options.now?.() ?? Date.now();

  if (
    !options.force &&
    !shouldCheckForUpdates({
      env,
      isTTY: options.isTTY,
      argv: options.argv,
    })
  ) {
    return {
      status: "disabled",
      updateAvailable: false,
      cache: {},
      skipped: false,
    };
  }

  const cachePath =
    options.cachePath ??
    getUpdateCachePath({
      platform: options.platform ?? Runtime.platform,
      env,
      homeDir: options.homeDir,
    });
  const readCache = options.readCache ?? readUpdateCache;
  const writeCache = options.writeCache ?? writeUpdateCache;
  const cache = await readCache(cachePath);

  if (
    !options.force &&
    isCacheFresh(cache, now, options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS)
  ) {
    return {
      status: "cached",
      updateAvailable: availableFor(cache, options.currentVersion),
      latest: cache.latest,
      cache,
      skipped: isVersionSkipped(cache, cache.latest),
    };
  }

  if (
    !options.force &&
    isNegativeCacheFresh(
      cache,
      now,
      options.negativeCacheMs ?? NEGATIVE_CACHE_MS,
    )
  ) {
    return {
      status: "failed",
      reason: "negative-cache",
      updateAvailable: availableFor(cache, options.currentVersion),
      latest: cache.latest,
      cache,
      skipped: isVersionSkipped(cache, cache.latest),
    };
  }

  const outcome = await checkForUpdate({
    currentVersion: options.currentVersion,
    fetchImpl: options.fetchImpl,
    registryBase: options.registryBase ?? resolveRegistryBase(env),
    timeoutMs: options.timeoutMs,
  });

  if (outcome.status === "error") {
    const failedCache: UpdateCache = { ...cache, failedAt: now };
    await writeCache(cachePath, failedCache);
    return {
      status: "failed",
      reason: outcome.reason,
      updateAvailable: availableFor(failedCache, options.currentVersion),
      latest: failedCache.latest,
      cache: failedCache,
      skipped: isVersionSkipped(failedCache, failedCache.latest),
    };
  }

  const nextCache: UpdateCache = {
    ...cache,
    checkedAt: now,
    latest: outcome.latest,
  };
  delete nextCache.failedAt;
  await writeCache(cachePath, nextCache);

  return {
    status: "checked",
    updateAvailable: availableFor(nextCache, options.currentVersion),
    latest: outcome.latest,
    cache: nextCache,
    skipped: isVersionSkipped(nextCache, outcome.latest),
  };
};
