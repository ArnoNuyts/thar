import { assertEquals } from "@std/assert";
import { MockWatcher } from "./test-utils.ts";

const withTimeout = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("MockWatcher iteration hung")),
      1000,
    );
    Deno.unrefTimer(timer);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

Deno.test("MockWatcher: yields events then completes after close", async () => {
  const watcher = new MockWatcher();
  const iterator = watcher[Symbol.asyncIterator]();

  const firstPending = iterator.next();
  watcher.emit("modify");
  const first = await withTimeout(firstPending);
  assertEquals(first.done, false);
  assertEquals(first.value?.kind, "modify");

  const secondPending = iterator.next();
  watcher.emit("any");
  const second = await withTimeout(secondPending);
  assertEquals(second.done, false);
  assertEquals(second.value?.kind, "any");

  const closePending = iterator.next();
  watcher.close();
  const end = await withTimeout(closePending);
  assertEquals(end.done, true);
  assertEquals(end.value, undefined);
});

Deno.test("MockWatcher: close resolves a pending wait", async () => {
  const watcher = new MockWatcher();
  const iterator = watcher[Symbol.asyncIterator]();

  const pending = iterator.next();
  watcher.close();

  const result = await withTimeout(pending);
  assertEquals(result.done, true);
  assertEquals(result.value, undefined);
});

Deno.test("MockWatcher: iterating after close completes immediately", async () => {
  const watcher = new MockWatcher();
  watcher.close();

  const result = await withTimeout(watcher[Symbol.asyncIterator]().next());
  assertEquals(result.done, true);
});
