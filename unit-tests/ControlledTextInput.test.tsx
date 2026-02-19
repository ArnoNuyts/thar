import { assertEquals } from "@std/assert";
import { render } from "ink-testing-library";
import React from "react";
import { ControlledTextInput } from "../components/ControlledTextInput.tsx";

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

  // Wait for update
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Ctrl+Left moves to word start", () => {
    // If implemented, it should be 6.
    assertEquals(
      lastCursorOffset,
      6,
      "Ctrl+Left did not move to start of 'world'",
    );
    assertEquals(lastValue, "hello world", "Ctrl+Left inserted text!");
  });

  // Move right word: should jump to 'hello world|' (pos 11)
  // Ctrl+Right escape code: \x1b[1;5C
  await stdin.write("\x1b[1;5C");
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Ctrl+Right moves to word end", () => {
    assertEquals(
      lastCursorOffset,
      11,
      "Ctrl+Right did not move to end of 'world'",
    );
    assertEquals(lastValue, "hello world", "Ctrl+Right inserted text!");
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
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Alt+Right produces no garbage", () => {
    assertEquals(lastValue, "test", "Alt+Right inserted garbage characters!");
  });

  // Shift+Alt+Right escape code: \x1b[1;4C
  await stdin.write("\x1b[1;4C");
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Alt+Shift+Right produces no garbage", () => {
    assertEquals(
      lastValue,
      "test",
      "Alt+Shift+Right inserted garbage characters!",
    );
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
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Filters out newline characters", () => {
    const hasNewline = lastValue.includes("\n") || lastValue.includes("\r");
    assertEquals(
      hasNewline,
      false,
      `Value should not contain newlines. Got: ${JSON.stringify(lastValue)}`,
    );
    assertEquals(submitCalled, false, "Should not trigger submit on paste");
    assertEquals(lastValue, "helloworld", "Should remove newline characters");
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

    return (
      <ControlledTextInput
        value={val}
        onChange={setVal}
      />
    );
  }

  const { stdin, unmount } = render(<Wrapper />);

  // Simulate pasting "  trimmed  "
  await stdin.write("  trimmed  ");
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Trims surrounding spaces", () => {
    assertEquals(
      currentValue,
      "trimmed",
      "Should trim surrounding spaces from pasted text",
    );
  });

  // Test that single space is NOT trimmed (simulate typing)
  await stdin.write(" ");
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Does not trim single space (typing)", () => {
    assertEquals(currentValue, "trimmed ", "Should append single space");
  });

  unmount();
});

Deno.test("ControlledTextInput - Ctrl+Backspace/Delete removes whole word", async (t) => {
  let currentValue = "hello world test";

  function Wrapper() {
    const [val, setVal] = React.useState("hello world test");
    const [cursor, setCursor] = React.useState(16); // End of string

    React.useEffect(() => {
      currentValue = val;
    }, [val]);

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
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Ctrl+Backspace removes word before cursor", () => {
    assertEquals(currentValue.trim(), "hello world", "Should remove 'test'");
  });

  // Move cursor to start of "world" -> "hello |world"
  // Ctrl+Left (\x1b[1;5D): "hello world |" -> "hello |world "
  await stdin.write("\x1b[1;5D"); // Ctrl+Left
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Now at "hello |world "
  // Ctrl+Delete (\x1b[3;5~) -> Should remove "world" -> "hello | "
  await stdin.write("\x1b[3;5~");
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Ctrl+Delete removes word after cursor", () => {
    assertEquals(currentValue.trim(), "hello");
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
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Ctrl+Delete on whitespace removes spaces and next word", () => {
    // "hello  world test" -> "hello| test"
    assertEquals(currentValue, "hello test");
  });

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
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Ctrl+Delete (\\x1bd) removes spaces and next word", () => {
    // "|hello world test" -> "|world test"
    assertEquals(currentValue, "world test");
  });

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
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Normal Delete only removes one character", () => {
    // "|hello world test" -> "|ello world test"
    assertEquals(currentValue, "ello world test");
  });

  unmount();
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
  await new Promise((resolve) => setTimeout(resolve, 100));

  await t.step("Mouse wheel packet should not modify input value", () => {
    assertEquals(currentValue, "hello");
  });

  unmount();
});
