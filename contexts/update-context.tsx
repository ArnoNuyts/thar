import { useApp } from "ink";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  detectInstallKind,
  getDefaultInstallDescriptor,
  getInstallCommand,
  type InstallCommand,
  type InstallDescriptor,
  type InstallKind,
} from "../logic/install-method.ts";
import { setPendingUpdate } from "../logic/pending-update.ts";
import { lookupNpmGlobalRoot } from "../logic/self-update.ts";
import {
  getUpdateCachePath,
  mutateUpdateCache,
} from "../logic/update-cache.ts";
import {
  runUpdateCheck,
  type FetchLike,
  type RunUpdateCheckResult,
} from "../logic/update-check.ts";
import { Runtime, type RuntimePlatform } from "../utils/runtime.ts";
import { useToaster } from "./toaster-context.tsx";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "error"
  | "updating";

export interface UpdateInitialState {
  status?: UpdateStatus;
  latestVersion?: string;
  skippedVersion?: string;
  installKind?: InstallKind;
}

export interface UpdateProviderOptions {
  enabled?: boolean;
  currentVersion?: string;
  initialState?: UpdateInitialState;
  autoCheckDelayMs?: number;
  jitterMs?: number;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  argv?: readonly string[];
  now?: () => number;
  platform?: RuntimePlatform;
  homeDir?: string;
  cachePath?: string;
  registryBase?: string;
  timeoutMs?: number;
  intervalMs?: number;
  negativeCacheMs?: number;
  installDescriptor?: InstallDescriptor;
  globalRootLookup?: () => Promise<string | undefined>;
  random?: () => number;
  check?: typeof runUpdateCheck;
  exit?: () => void;
}

export interface UpdateContextType {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | undefined;
  skippedVersion: string | undefined;
  isUpdateAvailable: boolean;
  installKind: InstallKind;
  updateCommand: InstallCommand;
  checkForUpdates: (options?: { force?: boolean }) => Promise<void>;
  skipVersion: () => void;
  prepareInstall: () => Promise<void>;
  startSelfUpdate: () => boolean;
}

const UpdateContext = createContext<UpdateContextType | null>(null);

export const useUpdate = (): UpdateContextType => {
  const context = useContext(UpdateContext);
  if (!context) {
    throw new Error("useUpdate must be used within an UpdateProvider");
  }
  return context;
};

const cachePathFor = (options: UpdateProviderOptions): string =>
  options.cachePath ??
  getUpdateCachePath({
    platform: options.platform ?? Runtime.platform,
    env: options.env ?? process.env,
    homeDir: options.homeDir,
  });

export const UpdateProvider = ({
  children,
  options = {},
}: {
  children?: React.ReactNode;
  options?: UpdateProviderOptions;
}) => {
  // The provider owns a snapshot of its configuration. Treating it as
  // immutable keeps every action referentially stable across unrelated
  // renders (the context-value stability tests rely on this).
  const optionsRef = useRef(options);
  const config = optionsRef.current;
  const descriptorRef = useRef(
    config.installDescriptor ?? getDefaultInstallDescriptor(),
  );

  const app = useApp();
  const exit = config.exit ?? app.exit;
  const { showToaster } = useToaster();

  const [currentVersion] = useState(config.currentVersion ?? __APP_VERSION__);
  const [status, setStatus] = useState<UpdateStatus>(
    config.initialState?.status ?? "idle",
  );
  const [latestVersion, setLatestVersion] = useState<string | undefined>(
    config.initialState?.latestVersion,
  );
  const [skippedVersion, setSkippedVersion] = useState<string | undefined>(
    config.initialState?.skippedVersion,
  );
  const [installKind, setInstallKind] = useState<InstallKind>(
    config.initialState?.installKind ??
      detectInstallKind(descriptorRef.current),
  );

  const lastNotifiedRef = useRef<string | undefined>(undefined);
  const checkInFlightRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const platform =
    config.platform ?? descriptorRef.current.platform ?? Runtime.platform;
  const updateCommand = useMemo(
    () => getInstallCommand(installKind, platform),
    [installKind, platform],
  );

  const notify = useCallback(
    async (result: RunUpdateCheckResult) => {
      if (!result.updateAvailable || !result.latest) return;
      if (
        result.cache.lastNotified === result.latest ||
        lastNotifiedRef.current === result.latest
      ) {
        return;
      }

      lastNotifiedRef.current = result.latest;
      showToaster(`Update available: v${result.latest} · press u`);
      await mutateUpdateCache(cachePathFor(optionsRef.current), (cache) => ({
        ...cache,
        lastNotified: result.latest,
      }));
    },
    [showToaster],
  );

  const checkForUpdates = useCallback(
    async (checkOptions?: { force?: boolean }) => {
      // Coalesce overlapping checks so a manual check cannot race the
      // background one (and write a stale cache result).
      if (checkInFlightRef.current) return checkInFlightRef.current;

      const run = (async () => {
        const current = optionsRef.current;
        const enabled = current.enabled ?? true;
        if (!enabled && !checkOptions?.force) return;

        setStatus("checking");
        const checker = current.check ?? runUpdateCheck;
        const result = await checker({
          currentVersion,
          env: current.env,
          isTTY: current.isTTY,
          argv: current.argv,
          now: current.now,
          fetchImpl: current.fetchImpl,
          cachePath: cachePathFor(current),
          registryBase: current.registryBase,
          timeoutMs: current.timeoutMs,
          intervalMs: current.intervalMs,
          negativeCacheMs: current.negativeCacheMs,
          force: checkOptions?.force,
          platform: current.platform ?? Runtime.platform,
          homeDir: current.homeDir,
        });

        if (!mountedRef.current) return;

        if (result.status === "disabled") {
          setStatus("idle");
          return;
        }

        if (result.latest) setLatestVersion(result.latest);

        if (result.updateAvailable) {
          setStatus("available");
          void notify(result);
          return;
        }

        setStatus(result.status === "failed" ? "error" : "up-to-date");
      })();

      checkInFlightRef.current = run;
      try {
        await run;
      } finally {
        checkInFlightRef.current = null;
      }
    },
    [currentVersion, notify],
  );

  useEffect(() => {
    const current = optionsRef.current;
    if (current.enabled === false) return;

    const jitterMs = current.jitterMs ?? 5_000;
    const random = current.random?.() ?? Math.random();
    const delay = Math.max(
      0,
      (current.autoCheckDelayMs ?? 2_000) + random * jitterMs,
    );
    const timer = setTimeout(() => {
      void checkForUpdates();
    }, delay);
    Runtime.unrefTimer(timer);

    return () => clearTimeout(timer);
  }, [checkForUpdates]);

  const skipVersion = useCallback(() => {
    if (!latestVersion) return;
    setSkippedVersion(latestVersion);

    void mutateUpdateCache(cachePathFor(optionsRef.current), (cache) => ({
      ...cache,
      skipped: latestVersion,
    }));
  }, [latestVersion]);

  const prepareInstall = useCallback(async () => {
    if (installKind !== "unknown") return;

    const current = optionsRef.current;
    const lookup =
      current.globalRootLookup ??
      (() =>
        lookupNpmGlobalRoot(undefined, current.platform ?? Runtime.platform));
    const root = await lookup();
    if (!root) return;

    const nextKind = detectInstallKind({
      ...descriptorRef.current,
      nodeModulesGlobalRoot: root,
    });
    if (nextKind !== "unknown") setInstallKind(nextKind);
  }, [installKind]);

  const startSelfUpdate = useCallback((): boolean => {
    if (!latestVersion || !updateCommand.canSelfUpdate) return false;

    setPendingUpdate({ command: updateCommand, version: latestVersion });
    setStatus("updating");
    exit();
    return true;
  }, [exit, latestVersion, updateCommand]);

  const isUpdateAvailable =
    status === "available" &&
    Boolean(latestVersion) &&
    skippedVersion !== latestVersion;

  const value = useMemo(
    () => ({
      status,
      currentVersion,
      latestVersion,
      skippedVersion,
      isUpdateAvailable,
      installKind,
      updateCommand,
      checkForUpdates,
      skipVersion,
      prepareInstall,
      startSelfUpdate,
    }),
    [
      status,
      currentVersion,
      latestVersion,
      skippedVersion,
      isUpdateAvailable,
      installKind,
      updateCommand,
      checkForUpdates,
      skipVersion,
      prepareInstall,
      startSelfUpdate,
    ],
  );

  return (
    <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
  );
};
