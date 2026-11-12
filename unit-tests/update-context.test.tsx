import { join } from "node:path";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect, useRef } from "react";
import { expect, test } from "vitest";

import { ToasterProvider, useToaster } from "../contexts/toaster-context.tsx";
import {
  UpdateProvider,
  useUpdate,
  type UpdateContextType,
} from "../contexts/update-context.tsx";
import { readUpdateCache, writeUpdateCache } from "../logic/update-cache.ts";
import type { FetchLike } from "../logic/update-check.ts";
import { Runtime } from "../utils/runtime.ts";
import { waitFor, waitPast } from "./test-utils.ts";

const npmDescriptor = {
  scriptPath: "/usr/local/lib/node_modules/todotui/dist/main.js",
  env: {},
  platform: "linux" as const,
};

const latestFetch =
  (version: string): FetchLike =>
  async () =>
    new Response(JSON.stringify({ name: "todotui", version }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await Runtime.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Runtime.remove(dir, { recursive: true });
  }
};

const Probe = ({
  onValue,
  onToast,
}: {
  onValue: (value: UpdateContextType) => void;
  onToast?: (message: string) => void;
}) => {
  const value = useUpdate();
  const { toasterMessage } = useToaster();
  const lastToast = useRef<string | undefined>(undefined);

  useEffect(() => {
    onValue(value);
  }, [onValue, value]);

  useEffect(() => {
    if (toasterMessage && toasterMessage !== lastToast.current) {
      lastToast.current = toasterMessage;
      onToast?.(toasterMessage);
    }
  }, [onToast, toasterMessage]);

  return null;
};

const SkipTrigger = () => {
  const { skipVersion } = useUpdate();
  useEffect(() => {
    skipVersion();
  }, [skipVersion]);
  return null;
};

test("UpdateProvider: value is referentially stable across unrelated re-renders", async () => {
  let latest: UpdateContextType | undefined;
  let renderCount = 0;

  const App = ({ tick }: { tick: number }) => (
    <ToasterProvider>
      <UpdateProvider options={{ enabled: false }}>
        <Probe
          onValue={(value) => {
            latest = value;
            renderCount++;
          }}
        />
        <Text>{tick}</Text>
      </UpdateProvider>
    </ToasterProvider>
  );

  const { rerender, unmount } = render(<App tick={0} />);
  expect(latest).toBeDefined();
  const firstValue = latest;
  const rendersBefore = renderCount;

  rerender(<App tick={1} />);
  await waitFor(() => {
    if (renderCount === rendersBefore) {
      throw new Error("Probe did not re-render");
    }
  });

  expect(latest).toBe(firstValue);
  unmount();
});

test("UpdateProvider: auto-checks after mount and notifies once per version", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "update-check.json");
    let latest: UpdateContextType | undefined;
    const toasts: string[] = [];

    const { unmount } = render(
      <ToasterProvider>
        <UpdateProvider
          options={{
            enabled: true,
            autoCheckDelayMs: 0,
            jitterMs: 0,
            isTTY: true,
            env: {},
            argv: [],
            cachePath,
            currentVersion: "0.4.0",
            fetchImpl: latestFetch("0.5.0"),
            installDescriptor: npmDescriptor,
          }}
        >
          <Probe
            onValue={(value) => {
              latest = value;
            }}
            onToast={(message) => toasts.push(message)}
          />
        </UpdateProvider>
      </ToasterProvider>,
    );

    await waitFor(() => {
      expect(latest?.status).toEqual("available");
      expect(latest?.latestVersion).toEqual("0.5.0");
      expect(latest?.isUpdateAvailable).toEqual(true);
    });

    await waitFor(async () => {
      const cache = await readUpdateCache(cachePath);
      expect(cache.latest).toEqual("0.5.0");
      expect(cache.lastNotified).toEqual("0.5.0");
    });

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatch(/0\.5\.0/);

    unmount();
  });
});

test("UpdateProvider: does not repeat the toast when the cache already notified", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "update-check.json");
    const now = Date.now();
    await writeUpdateCache(cachePath, {
      checkedAt: now,
      latest: "0.5.0",
      lastNotified: "0.5.0",
    });

    let latest: UpdateContextType | undefined;
    const toasts: string[] = [];

    const { unmount } = render(
      <ToasterProvider>
        <UpdateProvider
          options={{
            enabled: true,
            autoCheckDelayMs: 0,
            jitterMs: 0,
            isTTY: true,
            env: {},
            argv: [],
            cachePath,
            currentVersion: "0.4.0",
            now: () => now,
            fetchImpl: latestFetch("0.6.0"),
            installDescriptor: npmDescriptor,
          }}
        >
          <Probe
            onValue={(value) => {
              latest = value;
            }}
            onToast={(message) => toasts.push(message)}
          />
        </UpdateProvider>
      </ToasterProvider>,
    );

    await waitFor(() => {
      expect(latest?.status).toEqual("available");
      expect(latest?.latestVersion).toEqual("0.5.0");
    });

    expect(toasts).toHaveLength(0);
    unmount();
  });
});

test("UpdateProvider: skipVersion persists and hides the update", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "update-check.json");
    let latest: UpdateContextType | undefined;

    const { unmount } = render(
      <ToasterProvider>
        <UpdateProvider
          options={{
            enabled: false,
            currentVersion: "0.4.0",
            initialState: { status: "available", latestVersion: "0.5.0" },
            cachePath,
            installDescriptor: npmDescriptor,
          }}
        >
          <Probe
            onValue={(value) => {
              latest = value;
            }}
          />
          <SkipTrigger />
        </UpdateProvider>
      </ToasterProvider>,
    );

    await waitFor(() => {
      expect(latest?.skippedVersion).toEqual("0.5.0");
      expect(latest?.isUpdateAvailable).toEqual(false);
    });

    await waitFor(async () => {
      expect((await readUpdateCache(cachePath)).skipped).toEqual("0.5.0");
    });

    unmount();
  });
});

test("UpdateProvider: disabled providers never call fetch", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    let latest: UpdateContextType | undefined;

    const { unmount } = render(
      <ToasterProvider>
        <UpdateProvider
          options={{
            enabled: false,
            autoCheckDelayMs: 0,
            jitterMs: 0,
            isTTY: true,
            env: {},
            argv: [],
            cachePath: join(dir, "update-check.json"),
            currentVersion: "0.4.0",
            fetchImpl: async () => {
              calls++;
              return new Response(JSON.stringify({ version: "0.5.0" }));
            },
            installDescriptor: npmDescriptor,
          }}
        >
          <Probe
            onValue={(value) => {
              latest = value;
            }}
          />
        </UpdateProvider>
      </ToasterProvider>,
    );

    await waitPast(50);
    expect(calls).toEqual(0);
    expect(latest?.status).toEqual("idle");

    unmount();
  });
});

test("UpdateProvider: exposes the detected install command", async () => {
  let latest: UpdateContextType | undefined;

  const { unmount } = render(
    <ToasterProvider>
      <UpdateProvider
        options={{
          enabled: false,
          currentVersion: "0.4.0",
          initialState: { status: "available", latestVersion: "0.5.0" },
          installDescriptor: npmDescriptor,
        }}
      >
        <Probe
          onValue={(value) => {
            latest = value;
          }}
        />
      </UpdateProvider>
    </ToasterProvider>,
  );

  await waitFor(() => {
    expect(latest?.installKind).toEqual("npm-global");
    expect(latest?.updateCommand.display).toEqual(
      "npm install -g todotui@latest",
    );
    expect(latest?.updateCommand.canSelfUpdate).toEqual(true);
  });

  unmount();
});
