import { expect, test } from "vitest";

import { debounce } from "../utils/debounce.ts";
import { waitFor } from "./test-utils.ts";

test("debounce - coalesces calls and keeps the latest arguments", async () => {
  const calls: Array<[string, number]> = [];
  const debounced = debounce(
    (label: string, count: number) => calls.push([label, count]),
    10,
  );

  debounced("first", 1);
  debounced("second", 2);

  await waitFor(() => expect(calls).toEqual([["second", 2]]), {
    timeout: 1000,
  });
});

test("debounce - clear cancels only the pending invocation", async () => {
  const calls: string[] = [];
  const debounced = debounce((value: string) => calls.push(value), 10);

  debounced("cancelled");
  debounced.clear();
  debounced("kept");

  await waitFor(() => expect(calls).toEqual(["kept"]), { timeout: 1000 });
});

test("debounce - fires again on later calls", async () => {
  const calls: string[] = [];
  const debounced = debounce((value: string) => calls.push(value), 5);

  debounced("first");
  await waitFor(() => expect(calls).toEqual(["first"]), { timeout: 1000 });

  debounced("second");
  await waitFor(() => expect(calls).toEqual(["first", "second"]), {
    timeout: 1000,
  });
});
