import { assertEquals } from "@std/assert";
import { render } from "ink-testing-library";
import React from "react";
import { ControlledTextInput } from "../components/ControlledTextInput.tsx";
import { waitFor } from "./test-utils.ts";

Deno.test("ControlledTextInput - Ctrl+Left/Right moves by word", async (t) => {
  let lastValue = "hello world";
  let lastCursorOffset = 11; // End of string

  const { stdin, unmount } = render(
    <ControlledTextInput
      value={lastValue}
      onChange={(val) => {
        lastValue = val;
      }}
      onCursorChange={(offset) => {
        lastCursorOffset = offset;
      }}
      cursorOffset={lastCursorOffset}
    />,
  );

  // Initial state: cursor at end 'hello world|'
  // Move left word: should jump to 'hello |world' (pos 6)
  // Ctrl+Left escape code: \x1b[1;5D
  await stdin.write("\x1b[1;5D");

  await t.step("Ctrl+Left moves to word start", async () => {
    // If implemented, it should be 6.
    await waitFor(() => {
      assertEquals(
        lastCursorOffset,
        6,
        "Ctrl+Left did not move to start of 'world'",
      );
      assertEquals(lastValue, "hello world", "Ctrl+Left inserted text!");
    });
  });

  // Move right word: should jump to 'hello world|' (pos 11)
  // Ctrl+Right escape code: \x1b[1;5C
  await stdin.write("\x1b[1;5C");

  await t.step("Ctrl+Right moves to word end", async () => {
    await waitFor(() => {
      assertEquals(
        lastCursorOffset,
        11,
        "Ctrl+Right did not move to end of 'world'",
      );
      assertEquals(lastValue, "hello world", "Ctrl+Right inserted text!");
    });
  });

  unmount();
});

Deno.test("ControlledTextInput - Alt+Arrow does not insert garbage", async (t) => {
  let lastValue = "test";
  let lastCursorOffset = 4;

  const { stdin, unmount } = render(
    <ControlledTextInput
      value={lastValue}
      onChange={(val) => {
        lastValue = val;
      }}
      onCursorChange={(offset) => {
        lastCursorOffset = offset;
      }}
      cursorOffset={lastCursorOffset}
    />,
  );

  // Alt+Right escape code: \x1b[1;3C
  await stdin.write("\x1b[1;3C");

  await t.step("Alt+Right produces no garbage", async () => {
    await waitFor(() => {
      assertEquals(lastValue, "test", "Alt+Right inserted garbage characters!");
    });
  });

  // Shift+Alt+Right escape code: \x1b[1;4C
  await stdin.write("\x1b[1;4C");

  await t.step("Alt+Shift+Right produces no garbage", async () => {
    await waitFor(() => {
      assertEquals(
        lastValue,
        "test",
        "Alt+Shift+Right inserted garbage characters!",
      );
    });
  });

  unmount();
});

Deno.test("ControlledTextInput - Pasted text with newlines should be filtered out", async (t) => {
  let lastValue = "";
  let submitCalled = false;

  const { stdin, unmount } = render(
    <ControlledTextInput
      value={lastValue}
      onChange={(val) => {
        lastValue = val;
      }}
      onSubmit={() => {
        submitCalled = true;
      }}
    />,
  );

  // Simulate pasting "hello\nworld" as a single chunk
  await stdin.write("hello\nworld");

  await t.step("Filters out newline characters", async () => {
    await waitFor(() => {
      const hasNewline = lastValue.includes("\n") || lastValue.includes("\r");
      assertEquals(
        hasNewline,
        false,
        `Value should not contain newlines. Got: ${JSON.stringify(lastValue)}`,
      );
      assertEquals(submitCalled, false, "Should not trigger submit on paste");
      assertEquals(lastValue, "helloworld", "Should remove newline characters");
    });
  });

  unmount();
});

Deno.test("ControlledTextInput - Pasted text with surrounding spaces should be trimmed", async (t) => {
  let currentValue = "";

  function Wrapper() {
    const [val, setVal] = React.useState("");

    // Update the test variable whenever state changes
    React.useEffect(() => {
      currentValue = val;
    }, [val]);

    return <ControlledTextInput value={val} onChange={setVal} />;
  }

  const { stdin, unmount } = render(<Wrapper />);

  // Simulate pasting "  trimmed  "
  await stdin.write("  trimmed  ");

  await t.step("Trims surrounding spaces", async () => {
    await waitFor(() => {
      assertEquals(
        currentValue,
        "trimmed",
        "Should trim surrounding spaces from pasted text",
      );
    });
  });

  // Test that single space is NOT trimmed (simulate typing)
  await stdin.write(" ");

  await t.step("Does not trim single space (typing)", async () => {
    await waitFor(() => {
      assertEquals(currentValue, "trimmed ", "Should append single space");
    });
  });

  unmount();
});

Deno.test("ControlledTextInput - Ctrl+Backspace/Delete removes whole word", async (t) => {
  let currentValue = "hello world test";
  let currentCursor = 16;

  function Wrapper() {
    const [val, setVal] = React.useState("hello world test");
    const [cursor, setCursor] = React.useState(16); // End of string

    React.useEffect(() => {
      currentValue = val;
    }, [val]);

    React.useEffect(() => {
      currentCursor = cursor;
    }, [cursor]);

    return (
      <ControlledTextInput
        value={val}
        onChange={setVal}
        cursorOffset={cursor}
        onCursorChange={setCursor}
      />
    );
  }

  const { stdin, unmount } = render(<Wrapper />);

  // Initial: "hello world test|"
  // Ctrl+Backspace (\x17) -> Should remove "test" -> "hello world |"
  await stdin.write("\x17");

  await t.step("Ctrl+Backspace removes word before cursor", async () => {
    await waitFor(() => {
      assertEquals(currentValue.trim(), "hello world", "Should remove 'test'");
    });
  });

  // Move cursor to start of "world" -> "hello |world"
  // Ctrl+Left (\x1b[1;5D): "hello world |" -> "hello |world "
  await stdin.write("\x1b[1;5D"); // Ctrl+Left
  await waitFor(() => assertEquals(currentCursor, 6));

  // Now at "hello |world "
  // Ctrl+Delete (\x1b[3;5~) -> Should remove "world" -> "hello | "
  await stdin.write("\x1b[3;5~");

  await t.step("Ctrl+Delete removes word after cursor", async () => {
    await waitFor(() => {
      assertEquals(currentValue.trim(), "hello");
    });
  });

  unmount();
});

Deno.test("ControlledTextInput - Ctrl+Delete on whitespace removes next word", async (t) => {
  let currentValue = "hello  world test";
  const { stdin, unmount } = render(
    <ControlledTextInput
      value="hello  world test"
      onChange={(v) => {
        currentValue = v;
      }}
      cursorOffset={5} // "hello|  world test"
    />,
  );

  // Ctrl+Delete (\x1b[3;5~)
  await stdin.write("\x1b[3;5~");

  await t.step(
    "Ctrl+Delete on whitespace removes spaces and next word",
    async () => {
      // "hello  world test" -> "hello| test"
      await waitFor(() => {
        assertEquals(currentValue, "hello test");
      });
    },
  );

  unmount();
});

Deno.test("ControlledTextInput - Ctrl+Delete (\\x1bd) removes word after cursor", async (t) => {
  let currentValue = "hello world test";
  const { stdin, unmount } = render(
    <ControlledTextInput
      value="hello world test"
      onChange={(v) => {
        currentValue = v;
      }}
      cursorOffset={0} // "|hello world test"
    />,
  );

  // Ctrl+Delete (\x1bd)
  await stdin.write("\x1bd");

  await t.step(
    "Ctrl+Delete (\\x1bd) removes spaces and next word",
    async () => {
      // "|hello world test" -> "|world test"
      await waitFor(() => {
        assertEquals(currentValue, "world test");
      });
    },
  );

  unmount();
});

Deno.test("ControlledTextInput - Normal Delete should only remove one character", async (t) => {
  let currentValue = "hello world test";
  const { stdin, unmount } = render(
    <ControlledTextInput
      value="hello world test"
      onChange={(v) => {
        currentValue = v;
      }}
      cursorOffset={0} // "|hello world test"
    />,
  );

  // Normal Delete (\x1b[3~)
  await stdin.write("\x1b[3~");

  await t.step("Normal Delete only removes one character", async () => {
    // "|hello world test" -> "|ello world test"
    await waitFor(() => {
      assertEquals(currentValue, "ello world test");
    });
  });

  unmount();
});

type WordMotionState = {
  value: string;
  cursor: number;
};

function WordMotionHarness({
  initialValue,
  initialCursor,
  state,
}: {
  initialValue: string;
  initialCursor: number;
  state: WordMotionState;
}) {
  const [value, setValue] = React.useState(initialValue);
  const [cursor, setCursor] = React.useState(initialCursor);

  React.useEffect(() => {
    state.value = value;
    state.cursor = cursor;
  }, [value, cursor]);

  return (
    <ControlledTextInput
      value={value}
      onChange={setValue}
      cursorOffset={cursor}
      onCursorChange={setCursor}
    />
  );
}

async function pressWordMotion(
  initialValue: string,
  initialCursor: number,
  sequence: string,
  expected: WordMotionState,
) {
  const state: WordMotionState = {
    value: initialValue,
    cursor: initialCursor,
  };
  const { stdin, unmount } = render(
    <WordMotionHarness
      initialValue={initialValue}
      initialCursor={initialCursor}
      state={state}
    />,
  );

  try {
    await stdin.write(sequence);
    await waitFor(() => {
      assertEquals(state.cursor, expected.cursor, "unexpected cursor");
      assertEquals(state.value, expected.value, "unexpected value");
    });
  } finally {
    unmount();
  }
}

Deno.test("ControlledTextInput - Ctrl+Left word motion handles punctuation and spaces", async (t) => {
  const cases: Array<{
    name: string;
    value: string;
    cursor: number;
    sequence: string;
    expected: WordMotionState;
  }> = [
    {
      name: "punctuation is part of the word",
      value: "foo.bar baz",
      cursor: 11,
      sequence: "\x1b[1;5D",
      expected: { value: "foo.bar baz", cursor: 8 },
    },
    {
      name: "multiple spaces are skipped",
      value: "foo  bar",
      cursor: 8,
      sequence: "\x1b[1;5D",
      expected: { value: "foo  bar", cursor: 5 },
    },
    {
      name: "starting on whitespace lands on previous word start",
      value: "foo  bar",
      cursor: 3,
      sequence: "\x1b[1;5D",
      expected: { value: "foo  bar", cursor: 0 },
    },
    {
      name: "ctrl+shift+left uses the same word motion",
      value: "foo bar",
      cursor: 7,
      sequence: "\x1b[1;6D",
      expected: { value: "foo bar", cursor: 4 },
    },
  ];

  for (const { name, value, cursor, sequence, expected } of cases) {
    await t.step(name, async () => {
      await pressWordMotion(value, cursor, sequence, expected);
    });
  }
});

Deno.test("ControlledTextInput - Ctrl+Right word motion handles punctuation and spaces", async (t) => {
  const cases: Array<{
    name: string;
    value: string;
    cursor: number;
    sequence: string;
    expected: WordMotionState;
  }> = [
    {
      name: "punctuation is part of the word",
      value: "foo.bar baz",
      cursor: 0,
      sequence: "\x1b[1;5C",
      expected: { value: "foo.bar baz", cursor: 8 },
    },
    {
      name: "multiple spaces are skipped",
      value: "foo  bar",
      cursor: 0,
      sequence: "\x1b[1;5C",
      expected: { value: "foo  bar", cursor: 5 },
    },
    {
      name: "starting on whitespace stops at the next word start",
      value: "foo  bar",
      cursor: 3,
      sequence: "\x1b[1;5C",
      expected: { value: "foo  bar", cursor: 5 },
    },
    {
      name: "ctrl+shift+right uses the same word motion",
      value: "foo bar",
      cursor: 0,
      sequence: "\x1b[1;6C",
      expected: { value: "foo bar", cursor: 4 },
    },
  ];

  for (const { name, value, cursor, sequence, expected } of cases) {
    await t.step(name, async () => {
      await pressWordMotion(value, cursor, sequence, expected);
    });
  }
});

Deno.test("ControlledTextInput - Ctrl+Backspace word deletion handles punctuation and spaces", async (t) => {
  const cases: Array<{
    name: string;
    value: string;
    cursor: number;
    expected: WordMotionState;
  }> = [
    {
      name: "deletes punctuation word",
      value: "foo.bar baz",
      cursor: 11,
      expected: { value: "foo.bar ", cursor: 8 },
    },
    {
      name: "deletes word after multiple spaces",
      value: "foo  bar",
      cursor: 8,
      expected: { value: "foo  ", cursor: 5 },
    },
    {
      name: "deletes preceding word and spaces",
      value: "foo  bar",
      cursor: 5,
      expected: { value: "bar", cursor: 0 },
    },
    {
      name: "alt+backspace uses the same word deletion",
      value: "hello world",
      cursor: 11,
      expected: { value: "hello ", cursor: 6 },
    },
  ];

  for (const { name, value, cursor, expected } of cases) {
    await t.step(name, async () => {
      await pressWordMotion(
        value,
        cursor,
        name.startsWith("alt") ? "\x1b\x7f" : "\x17",
        expected,
      );
    });
  }
});

Deno.test("ControlledTextInput - Ctrl+Delete word deletion handles punctuation and spaces", async (t) => {
  const cases: Array<{
    name: string;
    value: string;
    cursor: number;
    expected: WordMotionState;
  }> = [
    {
      name: "deletes punctuation word",
      value: "foo.bar baz",
      cursor: 0,
      expected: { value: "baz", cursor: 0 },
    },
    {
      name: "deletes word and following spaces",
      value: "foo  bar",
      cursor: 0,
      expected: { value: "bar", cursor: 0 },
    },
    {
      name: "when starting on whitespace deletes spaces and next word",
      value: "foo  bar",
      cursor: 3,
      expected: { value: "foo", cursor: 3 },
    },
    {
      name: "when starting on whitespace keeps spaces after the deleted word",
      value: "foo  bar  baz",
      cursor: 3,
      expected: { value: "foo  baz", cursor: 3 },
    },
    {
      name: "when starting in a word deletes following spaces too",
      value: "foo  bar  baz",
      cursor: 0,
      expected: { value: "bar  baz", cursor: 0 },
    },
  ];

  for (const { name, value, cursor, expected } of cases) {
    await t.step(name, async () => {
      await pressWordMotion(value, cursor, "\x1b[3;5~", expected);
    });
  }
});

Deno.test("ControlledTextInput - word motion clamps at string boundaries", async (t) => {
  const cases: Array<{
    name: string;
    value: string;
    cursor: number;
    sequence: string;
    expected: WordMotionState;
  }> = [
    {
      name: "empty text ctrl+left then type",
      value: "",
      cursor: 0,
      sequence: "\x1b[1;5D",
      expected: { value: "x", cursor: 1 },
    },
    {
      name: "empty text ctrl+right then type",
      value: "",
      cursor: 0,
      sequence: "\x1b[1;5C",
      expected: { value: "x", cursor: 1 },
    },
    {
      name: "empty text ctrl+backspace then type",
      value: "",
      cursor: 0,
      sequence: "\x17",
      expected: { value: "x", cursor: 1 },
    },
    {
      name: "empty text ctrl+delete then type",
      value: "",
      cursor: 0,
      sequence: "\x1b[3;5~",
      expected: { value: "x", cursor: 1 },
    },
    {
      name: "ctrl+right at end stays at end",
      value: "foo bar",
      cursor: 7,
      sequence: "\x1b[1;5C",
      expected: { value: "foo barx", cursor: 8 },
    },
    {
      name: "ctrl+left at start stays at start",
      value: "foo bar",
      cursor: 0,
      sequence: "\x1b[1;5D",
      expected: { value: "xfoo bar", cursor: 1 },
    },
  ];

  for (const { name, value, cursor, sequence, expected } of cases) {
    await t.step(name, async () => {
      const state: WordMotionState = { value, cursor };
      const { stdin, unmount } = render(
        <WordMotionHarness
          initialValue={value}
          initialCursor={cursor}
          state={state}
        />,
      );

      try {
        await stdin.write(sequence);
        await stdin.write("x");
        await waitFor(() => {
          assertEquals(state.cursor, expected.cursor, "unexpected cursor");
          assertEquals(state.value, expected.value, "unexpected value");
        });
      } finally {
        unmount();
      }
    });
  }
});

Deno.test("ControlledTextInput - Mouse wheel escape does not insert characters", async (t) => {
  let currentValue = "hello";

  const { stdin, unmount } = render(
    <ControlledTextInput
      value="hello"
      onChange={(v) => {
        currentValue = v;
      }}
      cursorOffset={5}
    />,
  );

  // SGR mouse wheel up event
  await stdin.write("\x1b[<64;10;5M");

  await t.step("Mouse wheel packet should not modify input value", async () => {
    await waitFor(() => {
      assertEquals(currentValue, "hello");
    });
  });

  unmount();
});
