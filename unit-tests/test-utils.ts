import { setTimeout as delay } from "node:timers/promises";
import { Runtime, type FsEvent } from "../utils/runtime.ts";

export type MockedStdout = {
  rows: number;
};

export class MockWatcher {
  private listeners: ((event: FsEvent | undefined) => void)[] = [];
  private closed = false;
  private nextCalls = 0;

  get nextCallCount() {
    return this.nextCalls;
  }

  private nextEvent(): Promise<FsEvent | undefined> {
    this.nextCalls++;
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.listeners.push(resolve);
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<FsEvent> {
    const event = await this.nextEvent();
    if (!event) return;
    yield event;
    yield* this[Symbol.asyncIterator]();
  }

  emit(kind: "modify" | "any") {
    const event: FsEvent = { kind, paths: ["test.txt"], flag: undefined };
    const listeners = this.listeners;
    this.listeners = [];
    listeners.forEach((l) => l(event));
  }

  close() {
    this.closed = true;
    const listeners = this.listeners;
    this.listeners = [];
    listeners.forEach((l) => l(undefined));
  }
}

// Originals for tests that patch the runtime adapter.
export const originalWatchFs = Runtime.watchFs;
export const originalReadTextFile = Runtime.readTextFile;
export const originalWriteTextFile = Runtime.writeTextFile;
export const originalStat = Runtime.stat;

export function restoreRuntimeMocks() {
  Runtime.watchFs = originalWatchFs;
  Runtime.readTextFile = originalReadTextFile;
  Runtime.writeTextFile = originalWriteTextFile;
  Runtime.stat = originalStat;
}

export async function waitFor(
  callback: () => void | Promise<void>,
  options?: { timeout?: number; interval?: number },
) {
  const timeout = options?.timeout ?? 5000;
  const interval = options?.interval ?? 1;

  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeout) {
    try {
      await callback();
      return;
    } catch (e) {
      lastError = e;
      await delay(interval);
    }
  }

  const errorMessage =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out after ${timeout}ms. Last error: ${errorMessage}`);
}

/**
 * Polls until at least `ms` milliseconds have elapsed. Use this only when
 * there is no observable state to wait for, such as a debounce that must run
 * before the next step.
 */
export async function waitPast(ms: number, interval = 10) {
  const start = Date.now();
  await waitFor(
    () => {
      if (Date.now() - start < ms) {
        throw new Error(`Waiting for ${ms}ms`);
      }
    },
    { interval },
  );
}
