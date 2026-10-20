import { expect, test } from "vitest";

import { render } from "ink-testing-library";
import React from "react";
import { ControlledTextInput } from "../components/ControlledTextInput.tsx";
import { waitFor } from "./test-utils.ts";

test("ControlledTextInput - Ctrl+Left/Right moves by word", async () => {
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

  await (async () => {
    // If implemented, it should be 6.
    await waitFor(() => {
      expect(
        lastCursorOffset,
        "Ctrl+Left did not move to start of 'world'",
      ).toEqual(6);
      expect(lastValue, "Ctrl+Left inserted text!").toEqual("hello world");
    });
  })();

  // Move right word: should jump to 'hello world|' (pos 11)
  // Ctrl+Right escape code: \x1b[1;5C
  await stdin.write("\x1b[1;5C");

  await (async () => {
    await waitFor(() => {
      expect(
        lastCursorOffset,
        "Ctrl+Right did not move to end of 'world'",
      ).toEqual(11);
      expect(lastValue, "Ctrl+Right inserted text!").toEqual("hello world");
    });
  })();

  unmount();
});

test("ControlledTextInput - Alt+Arrow does not insert garbage", async () => {
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

  await (async () => {
    await waitFor(() => {
      expect(lastValue, "Alt+Right inserted garbage characters!").toEqual(
        "test",
      );
    });
  })();

  // Shift+Alt+Right escape code: \x1b[1;4C
  await stdin.write("\x1b[1;4C");

  await (async () => {
    await waitFor(() => {
      expect(lastValue, "Alt+Shift+Right inserted garbage characters!").toEqual(
        "test",
      );
    });
  })();

  unmount();
});

test("ControlledTextInput - Pasted text with newlines should be filtered out", async () => {
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

  await (async () => {
    await waitFor(() => {
      const hasNewline = lastValue.includes("\n") || lastValue.includes("\r");
      expect(
        hasNewline,
        `Value should not contain newlines. Got: ${JSON.stringify(lastValue)}`,
      ).toEqual(false);
      expect(submitCalled, "Should not trigger submit on paste").toEqual(false);
      expect(lastValue, "Should remove newline characters").toEqual(
        "helloworld",
      );
    });
  })();

  unmount();
});

test("ControlledTextInput - Pasted text with surrounding spaces should be trimmed", async () => {
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

  await (async () => {
    await waitFor(() => {
      expect(
        currentValue,
        "Should trim surrounding spaces from pasted text",
      ).toEqual("trimmed");
    });
  })();

  // Test that single space is NOT trimmed (simulate typing)
  await stdin.write(" ");

  await (async () => {
    await waitFor(() => {
      expect(currentValue, "Should append single space").toEqual("trimmed ");
    });
  })();

  unmount();
});

test("ControlledTextInput - Ctrl+Backspace/Delete removes whole word", async () => {
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

  await (async () => {
    await waitFor(() => {
      expect(currentValue.trim(), "Should remove 'test'").toEqual(
        "hello world",
      );
    });
  })();

  // Move cursor to start of "world" -> "hello |world"
  // Ctrl+Left (\x1b[1;5D): "hello world |" -> "hello |world "
  await stdin.write("\x1b[1;5D"); // Ctrl+Left
  await waitFor(() => expect(currentCursor).toEqual(6));

  // Now at "hello |world "
  // Ctrl+Delete (\x1b[3;5~) -> Should remove "world" -> "hello | "
  await stdin.write("\x1b[3;5~");

  await (async () => {
    await waitFor(() => {
      expect(currentValue.trim()).toEqual("hello");
    });
  })();

  unmount();
});

test("ControlledTextInput - Ctrl+Delete on whitespace removes next word", async () => {
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

  await (async () => {
    // "hello  world test" -> "hello| test"
    await waitFor(() => {
      expect(currentValue).toEqual("hello test");
    });
  })();

  unmount();
});

test("ControlledTextInput - Ctrl+Delete (\\x1bd) removes word after cursor", async () => {
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

  await (async () => {
    // "|hello world test" -> "|world test"
    await waitFor(() => {
      expect(currentValue).toEqual("world test");
    });
  })();

  unmount();
});

test("ControlledTextInput - Normal Delete should only remove one character", async () => {
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

  await (async () => {
    // "|hello world test" -> "|ello world test"
    await waitFor(() => {
      expect(currentValue).toEqual("ello world test");
    });
  })();

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
      expect(state.cursor, "unexpected cursor").toEqual(expected.cursor);
      expect(state.value, "unexpected value").toEqual(expected.value);
    });
  } finally {
    unmount();
  }
}

test("ControlledTextInput - Ctrl+Left word motion handles punctuation and spaces", async () => {
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

  for (const { value, cursor, sequence, expected } of cases) {
    await (async () => {
      await pressWordMotion(value, cursor, sequence, expected);
    })();
  }
});

test("ControlledTextInput - Ctrl+Right word motion handles punctuation and spaces", async () => {
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

  for (const { value, cursor, sequence, expected } of cases) {
    await (async () => {
      await pressWordMotion(value, cursor, sequence, expected);
    })();
  }
});

test("ControlledTextInput - Ctrl+Backspace word deletion handles punctuation and spaces", async () => {
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
    await (async () => {
      await pressWordMotion(
        value,
        cursor,
        name.startsWith("alt") ? "\x1b\x7f" : "\x17",
        expected,
      );
    })();
  }
});

test("ControlledTextInput - Ctrl+Delete word deletion handles punctuation and spaces", async () => {
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

  for (const { value, cursor, expected } of cases) {
    await (async () => {
      await pressWordMotion(value, cursor, "\x1b[3;5~", expected);
    })();
  }
});

test("ControlledTextInput - word motion clamps at string boundaries", async () => {
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

  for (const { value, cursor, sequence, expected } of cases) {
    await (async () => {
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
          expect(state.cursor, "unexpected cursor").toEqual(expected.cursor);
          expect(state.value, "unexpected value").toEqual(expected.value);
        });
      } finally {
        unmount();
      }
    })();
  }
});

test("ControlledTextInput - Mouse wheel escape does not insert characters", async () => {
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

  await (async () => {
    await waitFor(() => {
      expect(currentValue).toEqual("hello");
    });
  })();

  unmount();
});
