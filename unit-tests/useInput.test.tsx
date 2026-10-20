import { expect, test } from "vitest";

import { render } from "ink-testing-library";
import { Text } from "ink";
import { type Key, useInput } from "../hooks/useInput.ts";
import { waitFor } from "./test-utils.ts";

type Captured = {
  input: string;
  key: Key;
};

function Harness({ captured }: { captured: Captured[] }) {
  useInput((input, key) => {
    captured.push({ input, key });
  });

  return <Text>input</Text>;
}

async function press(sequence: string): Promise<Captured> {
  const captured: Captured[] = [];
  const { stdin, unmount } = render(<Harness captured={captured} />);

  try {
    await stdin.write(sequence);
    await waitFor(() => expect(captured.length).toEqual(1));
    return captured[0];
  } finally {
    unmount();
  }
}

const modifierFlags = (key: Key) => ({
  shift: key.shift,
  ctrl: key.ctrl,
  meta: key.meta,
});

test("useInput - escape sequences set the expected modifier flags", async () => {
  // Representative sequences from the shift, ctrl and meta sets, plus
  // sequences that intentionally belong to more than one set.
  const cases: Array<{
    name: string;
    sequence: string;
    expected: { shift: boolean; ctrl: boolean; meta: boolean };
  }> = [
    {
      name: "shift+up",
      sequence: "\x1b[1;2A",
      expected: { shift: true, ctrl: false, meta: false },
    },
    {
      name: "shift+delete (urxvt)",
      sequence: "\x1b[3$",
      expected: { shift: true, ctrl: false, meta: false },
    },
    {
      name: "shift+tab",
      sequence: "\x1b[Z",
      expected: { shift: true, ctrl: false, meta: false },
    },
    {
      name: "ctrl+up",
      sequence: "\x1b[1;5A",
      expected: { shift: false, ctrl: true, meta: false },
    },
    {
      name: "ctrl+w",
      sequence: "\x17",
      expected: { shift: false, ctrl: true, meta: false },
    },
    {
      name: "alt+up",
      sequence: "\x1b[1;3A",
      expected: { shift: false, ctrl: false, meta: true },
    },
    {
      name: "alt+backspace",
      sequence: "\x1b\x7f",
      expected: { shift: false, ctrl: false, meta: true },
    },
    {
      name: "alt+left (windows terminal)",
      sequence: "\x1b[1;9A",
      expected: { shift: false, ctrl: false, meta: true },
    },
    {
      name: "ctrl+shift+alt+up (overlaps all three sets)",
      sequence: "\x1b[1;8A",
      expected: { shift: true, ctrl: true, meta: true },
    },
    {
      name: "ctrl+shift+delete (urxvt, overlaps shift and ctrl)",
      sequence: "\x1b[3@",
      expected: { shift: true, ctrl: true, meta: false },
    },
    {
      name: "ctrl+shift+up (overlaps shift and ctrl)",
      sequence: "\x1b[1;6A",
      expected: { shift: true, ctrl: true, meta: false },
    },
    {
      name: "shift+alt+delete (overlaps shift and meta)",
      sequence: "\x1b[3;4~",
      expected: { shift: true, ctrl: false, meta: true },
    },
    {
      name: "shift+alt+up (overlaps shift and meta)",
      sequence: "\x1b[1;4A",
      expected: { shift: true, ctrl: false, meta: true },
    },
  ];

  for (const { sequence, expected } of cases) {
    await (async () => {
      const captured = await press(sequence);
      expect(modifierFlags(captured.key)).toEqual(expected);
    })();
  }
});

test("useInput - alt+character keeps meta set by the parsed sequence", async () => {
  const captured = await press("\x1ba");

  expect(captured.input).toEqual("a");
  expect(modifierFlags(captured.key)).toEqual({
    shift: false,
    ctrl: false,
    meta: true,
  });
});
