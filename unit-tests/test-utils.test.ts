import { expect, test } from "vitest";

import { MockWatcher } from "./test-utils.ts";

const withTimeout = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    const id = setTimeout(
      () => reject(new Error("MockWatcher iteration hung")),
      1000,
    );
    timer = id;
    if (typeof id === "object") id.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

test("MockWatcher: yields events then completes after close", async () => {
  const watcher = new MockWatcher();
  const iterator = watcher[Symbol.asyncIterator]();

  const firstPending = iterator.next();
  watcher.emit("modify");
  const first = await withTimeout(firstPending);
  expect(first.done).toEqual(false);
  expect(first.value?.kind).toEqual("modify");

  const secondPending = iterator.next();
  watcher.emit("any");
  const second = await withTimeout(secondPending);
  expect(second.done).toEqual(false);
  expect(second.value?.kind).toEqual("any");

  const closePending = iterator.next();
  watcher.close();
  const end = await withTimeout(closePending);
  expect(end.done).toEqual(true);
  expect(end.value).toEqual(undefined);
});

test("MockWatcher: close resolves a pending wait", async () => {
  const watcher = new MockWatcher();
  const iterator = watcher[Symbol.asyncIterator]();

  const pending = iterator.next();
  watcher.close();

  const result = await withTimeout(pending);
  expect(result.done).toEqual(true);
  expect(result.value).toEqual(undefined);
});

test("MockWatcher: iterating after close completes immediately", async () => {
  const watcher = new MockWatcher();
  watcher.close();

  const result = await withTimeout(watcher[Symbol.asyncIterator]().next());
  expect(result.done).toEqual(true);
});
