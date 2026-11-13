import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  buildLatestManifestUrl,
  checkForUpdate,
  DEFAULT_REGISTRY_BASE,
  MAX_RESPONSE_BYTES,
  resolveRegistryBase,
  runUpdateCheck,
  shouldCheckForUpdates,
  UPDATE_TIMEOUT_MS,
  type FetchLike,
} from "../logic/update-check.ts";
import { readUpdateCache, writeUpdateCache } from "../logic/update-cache.ts";
import { Runtime } from "../utils/runtime.ts";

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("update-check: resolves the registry base URL", () => {
  expect(resolveRegistryBase({})).toEqual(DEFAULT_REGISTRY_BASE);
  expect(
    resolveRegistryBase({ THAR_REGISTRY: "http://127.0.0.1:1234/" }),
  ).toEqual("http://127.0.0.1:1234");
  expect(
    resolveRegistryBase({
      THAR_REGISTRY: " ",
      npm_config_registry: "https://registry.example.test/",
    }),
  ).toEqual("https://registry.example.test");
  expect(buildLatestManifestUrl("http://127.0.0.1:1234/")).toEqual(
    "http://127.0.0.1:1234/%40arnoarnoarno%2Fthar/latest",
  );
});

test("update-check: gating skips non-TTY, CI, npm lifecycle and opt-outs", () => {
  expect(shouldCheckForUpdates({ env: {}, isTTY: true })).toEqual(true);
  expect(shouldCheckForUpdates({ env: {}, isTTY: false })).toEqual(false);
  expect(shouldCheckForUpdates({ env: { CI: "true" }, isTTY: true })).toEqual(
    false,
  );
  expect(shouldCheckForUpdates({ env: { CI: "1" }, isTTY: true })).toEqual(
    false,
  );
  expect(shouldCheckForUpdates({ env: { CI: "0" }, isTTY: true })).toEqual(
    true,
  );
  expect(
    shouldCheckForUpdates({
      env: { npm_lifecycle_event: "test" },
      isTTY: true,
    }),
  ).toEqual(false);
  expect(
    shouldCheckForUpdates({
      env: { npm_lifecycle_event: "npx" },
      isTTY: true,
    }),
  ).toEqual(true);
  expect(
    shouldCheckForUpdates({
      env: { npm_lifecycle_event: "exec" },
      isTTY: true,
    }),
  ).toEqual(true);
  expect(
    shouldCheckForUpdates({ env: { VITEST: "true" }, isTTY: true }),
  ).toEqual(false);
  expect(
    shouldCheckForUpdates({ env: { NODE_ENV: "test" }, isTTY: true }),
  ).toEqual(false);
  expect(
    shouldCheckForUpdates({
      env: { THAR_NO_UPDATE_CHECK: "1" },
      isTTY: true,
    }),
  ).toEqual(false);
  expect(
    shouldCheckForUpdates({
      env: { THAR_NO_UPDATE_CHECK: "0" },
      isTTY: true,
    }),
  ).toEqual(true);
  expect(
    shouldCheckForUpdates({ env: { NO_UPDATE_NOTIFIER: "1" }, isTTY: true }),
  ).toEqual(false);
  expect(
    shouldCheckForUpdates({
      env: {},
      isTTY: true,
      argv: ["--no-update-check"],
    }),
  ).toEqual(false);
});

test("update-check: fetches the latest manifest with the expected headers", async () => {
  let requestedUrl = "";
  let headers: Record<string, string> = {};
  const fetchImpl: FetchLike = async (input, init) => {
    requestedUrl = input;
    headers = init?.headers as Record<string, string>;
    return okResponse({ name: "todotui", version: "0.5.0" });
  };

  const outcome = await checkForUpdate({
    currentVersion: "0.4.0",
    fetchImpl,
    registryBase: "http://registry.test",
  });

  expect(requestedUrl).toEqual(
    "http://registry.test/%40arnoarnoarno%2Fthar/latest",
  );
  expect(headers.Accept).toEqual("application/json");
  expect(headers["User-Agent"]).toEqual("thar/0.4.0");
  expect(outcome).toEqual({
    status: "update-available",
    current: "0.4.0",
    latest: "0.5.0",
  });
});

test("update-check: reports up-to-date and older registry versions", async () => {
  const fetchImpl: FetchLike = async () => okResponse({ version: "0.4.0" });
  expect(await checkForUpdate({ currentVersion: "0.4.0", fetchImpl })).toEqual({
    status: "up-to-date",
    current: "0.4.0",
    latest: "0.4.0",
  });

  const older: FetchLike = async () => okResponse({ version: "0.3.9" });
  expect(
    await checkForUpdate({ currentVersion: "0.4.0", fetchImpl: older }),
  ).toEqual({ status: "up-to-date", current: "0.4.0", latest: "0.3.9" });
});

test("update-check: HTTP failures are silent", async () => {
  for (const status of [404, 500]) {
    const fetchImpl: FetchLike = async () => new Response("nope", { status });
    const outcome = await checkForUpdate({
      currentVersion: "0.4.0",
      fetchImpl,
    });
    expect(outcome.status).toEqual("error");
    if (outcome.status === "error") expect(outcome.reason).toEqual("http");
  }
});

test("update-check: network errors and invalid JSON are silent", async () => {
  const offline: FetchLike = async () => {
    throw new Error("offline");
  };
  const networkOutcome = await checkForUpdate({
    currentVersion: "0.4.0",
    fetchImpl: offline,
  });
  expect(networkOutcome.status).toEqual("error");
  if (networkOutcome.status === "error") {
    expect(networkOutcome.reason).toEqual("network");
  }

  const invalidJson: FetchLike = async () =>
    new Response("{ nope", { status: 200 });
  const invalidOutcome = await checkForUpdate({
    currentVersion: "0.4.0",
    fetchImpl: invalidJson,
  });
  expect(invalidOutcome.status).toEqual("error");
  if (invalidOutcome.status === "error") {
    expect(invalidOutcome.reason).toEqual("invalid");
  }

  const invalidVersion: FetchLike = async () => okResponse({ version: "nope" });
  const versionOutcome = await checkForUpdate({
    currentVersion: "0.4.0",
    fetchImpl: invalidVersion,
  });
  expect(versionOutcome.status).toEqual("error");
  if (versionOutcome.status === "error") {
    expect(versionOutcome.reason).toEqual("invalid");
  }
});

test("update-check: oversized responses are rejected", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response("x".repeat(MAX_RESPONSE_BYTES + 1), { status: 200 });
  const outcome = await checkForUpdate({
    currentVersion: "0.4.0",
    fetchImpl,
  });
  expect(outcome.status).toEqual("error");
  if (outcome.status === "error") {
    expect(outcome.reason).toEqual("too-large");
  }
});

test("update-check: times out without throwing", async () => {
  const fetchImpl: FetchLike = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });

  const outcome = await checkForUpdate({
    currentVersion: "0.4.0",
    fetchImpl,
    timeoutMs: 5,
  });
  expect(outcome.status).toEqual("error");
  if (outcome.status === "error") expect(outcome.reason).toEqual("timeout");
  expect(UPDATE_TIMEOUT_MS).toBeGreaterThan(0);
});

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await Runtime.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Runtime.remove(dir, { recursive: true });
  }
};

test("update-check: disabled checks never call fetch", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return okResponse({ version: "0.5.0" });
    };

    const result = await runUpdateCheck({
      currentVersion: "0.4.0",
      cachePath: join(dir, "update-check.json"),
      env: { THAR_NO_UPDATE_CHECK: "1" },
      isTTY: true,
      fetchImpl,
    });

    expect(result.status).toEqual("disabled");
    expect(result.updateAvailable).toEqual(false);
    expect(calls).toEqual(0);
  });
});

test("update-check: a fresh cache avoids the network and preserves the result", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "update-check.json");
    const now = 10_000_000;
    await writeUpdateCache(cachePath, {
      checkedAt: now - 1_000,
      latest: "0.5.0",
    });

    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return okResponse({ version: "0.6.0" });
    };

    const result = await runUpdateCheck({
      currentVersion: "0.4.0",
      cachePath,
      env: {},
      isTTY: true,
      now: () => now,
      fetchImpl,
    });

    expect(result.status).toEqual("cached");
    expect(result.latest).toEqual("0.5.0");
    expect(result.updateAvailable).toEqual(true);
    expect(calls).toEqual(0);
  });
});

test("update-check: an expired cache refreshes and writes the new result", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "update-check.json");
    const now = 90_000_000;
    await writeUpdateCache(cachePath, { checkedAt: 0, latest: "0.4.0" });

    const result = await runUpdateCheck({
      currentVersion: "0.4.0",
      cachePath,
      env: {},
      isTTY: true,
      now: () => now,
      fetchImpl: async () => okResponse({ version: "0.5.0" }),
    });

    expect(result.status).toEqual("checked");
    expect(result.updateAvailable).toEqual(true);
    expect(result.latest).toEqual("0.5.0");
    expect(await readUpdateCache(cachePath)).toEqual({
      checkedAt: now,
      latest: "0.5.0",
    });
  });
});

test("update-check: failures negative-cache for an hour and keep the old latest", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "update-check.json");
    const now = 90_000_000;
    await writeUpdateCache(cachePath, { checkedAt: 0, latest: "0.5.0" });

    const first = await runUpdateCheck({
      currentVersion: "0.4.0",
      cachePath,
      env: {},
      isTTY: true,
      now: () => now,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });

    expect(first.status).toEqual("failed");
    expect(first.updateAvailable).toEqual(true);
    expect((await readUpdateCache(cachePath)).failedAt).toEqual(now);

    let calls = 0;
    const second = await runUpdateCheck({
      currentVersion: "0.4.0",
      cachePath,
      env: {},
      isTTY: true,
      now: () => now + 60_000,
      fetchImpl: async () => {
        calls++;
        return okResponse({ version: "0.6.0" });
      },
    });

    expect(second.status).toEqual("failed");
    expect(second.reason).toEqual("negative-cache");
    expect(calls).toEqual(0);
  });
});

test("update-check: skipped versions are not reported as available", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "update-check.json");
    const now = 40_000_000;
    await writeUpdateCache(cachePath, {
      checkedAt: now - 1_000,
      latest: "0.5.0",
      skipped: "0.5.0",
    });

    const result = await runUpdateCheck({
      currentVersion: "0.4.0",
      cachePath,
      env: {},
      isTTY: true,
      now: () => now,
    });

    expect(result.status).toEqual("cached");
    expect(result.latest).toEqual("0.5.0");
    expect(result.updateAvailable).toEqual(false);
    expect(result.skipped).toEqual(true);
  });
});

test("update-check: force bypasses gating and the cache", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "update-check.json");
    await writeUpdateCache(cachePath, {
      checkedAt: 50_000_000,
      latest: "0.4.0",
    });

    let calls = 0;
    const result = await runUpdateCheck({
      currentVersion: "0.4.0",
      cachePath,
      env: { CI: "true" },
      isTTY: false,
      force: true,
      now: () => 50_000_000,
      fetchImpl: async () => {
        calls++;
        return okResponse({ version: "0.5.0" });
      },
    });

    expect(calls).toEqual(1);
    expect(result.status).toEqual("checked");
    expect(result.updateAvailable).toEqual(true);
  });
});

test("update-check: a local mock registry works end to end", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "todotui", version: "0.6.0" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to bind the mock registry");
  }

  try {
    const result = await runUpdateCheck({
      currentVersion: "0.5.0",
      cachePath: join(await Runtime.makeTempDir(), "cache.json"),
      env: {},
      isTTY: true,
      force: true,
      registryBase: `http://127.0.0.1:${address.port}`,
    });

    expect(requests).toEqual(["/%40arnoarnoarno%2Fthar/latest"]);
    expect(result.status).toEqual("checked");
    expect(result.latest).toEqual("0.6.0");
    expect(result.updateAvailable).toEqual(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
