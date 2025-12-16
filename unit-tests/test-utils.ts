export class MockWatcher {
  private listeners: ((event: Deno.FsEvent) => void)[] = [];
  private closed = false;

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Deno.FsEvent> {
    while (!this.closed) {
      const event = await new Promise<Deno.FsEvent>((resolve) => {
        this.listeners.push(resolve);
      });
      if (this.closed) break;
      yield event;
    }
  }

  emit(kind: "modify" | "any") {
    const event: Deno.FsEvent = { kind, paths: ["test.txt"], flag: undefined };
    const listeners = this.listeners;
    this.listeners = [];
    listeners.forEach((l) => l(event));
  }

  close() {
    this.closed = true;
    this.listeners.forEach((l) =>
      l({ kind: "any", paths: [], flag: undefined })
    );
    this.listeners = [];
  }
}

// Mock Deno APIs (Originals)
export const originalWatchFs = Deno.watchFs;
export const originalReadTextFile = Deno.readTextFile;
export const originalWriteTextFile = Deno.writeTextFile;
export const originalStat = Deno.stat;

export function restoreDenoMocks() {
  // deno-lint-ignore no-explicit-any
  (Deno as any).watchFs = originalWatchFs;
  // deno-lint-ignore no-explicit-any
  (Deno as any).readTextFile = originalReadTextFile;
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = originalWriteTextFile;
  // deno-lint-ignore no-explicit-any
  (Deno as any).stat = originalStat;
}

import { delay } from "@std/async";

export async function waitFor(
  callback: () => void | Promise<void>,
  options?: { timeout?: number; interval?: number },
) {
  const timeout = options?.timeout ?? 5000;
  const interval = options?.interval ?? 50;

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

  const errorMessage = lastError instanceof Error
    ? lastError.message
    : String(lastError);
  throw new Error(`Timed out after ${timeout}ms. Last error: ${errorMessage}`);
}
