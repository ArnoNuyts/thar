import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { useState } from "react";
import { Text } from "ink";

import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import { waitFor } from "./test-utils.ts";
import { SuggestionInput } from "../components/SuggestionInput.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import {
  SuggestionProvider,
  useSuggestion,
} from "../contexts/suggestion-context.tsx";
import { useFocusable } from "../hooks/useFocusable.ts";

// Regression coverage for the suggestion input notifying its parent from the
// input event path instead of a useEffect. The parent uses the flag to decide
// whether Tab should move focus to its buttons, so it must track typing,
// Escape and suggestion application.

const makeTodos = () => [
  new Todo("Task one +project-a +personal @home @office"),
  new Todo("Task two +project-b @context"),
];

const SuggestionProbe = () => {
  const { suggestions } = useSuggestion();
  return <Text>{`suggestions:${suggestions.length}`}</Text>;
};

const SuggestionHarness = ({
  todos,
  onSuggestionsStateChange,
}: {
  todos: Todos;
  onSuggestionsStateChange: (hasSuggestions: boolean) => void;
}) => {
  const [value, setValue] = useState("");

  return (
    <SuggestionProvider>
      <SuggestionInput
        value={value}
        onChange={setValue}
        onCursorChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        onSuggestionsStateChange={onSuggestionsStateChange}
        isFocused
        todos={todos}
        left={0}
        top={0}
      />
      <SuggestionProbe />
    </SuggestionProvider>
  );
};

const renderHarness = () => {
  const states: boolean[] = [];
  const result = render(
    <SuggestionHarness
      todos={makeTodos()}
      onSuggestionsStateChange={(hasSuggestions) => {
        states.push(hasSuggestions);
      }}
    />,
  );

  return {
    ...result,
    states,
    lastState: () => states[states.length - 1],
  };
};

test("SuggestionInput: reports suggestion state while typing", async () => {
  const result = renderHarness();

  try {
    result.stdin.write("+pro");

    await waitFor(() => {
      expect(result.lastState()).toEqual(true);
      expect(result.lastFrame() ?? "").toMatch(/suggestions:2/);
    });

    // Removing the tag prefix means there is no word start anymore.
    result.stdin.write("\x7f");
    result.stdin.write("\x7f");
    result.stdin.write("\x7f");
    result.stdin.write("\x7f");

    await waitFor(() => {
      expect(result.lastState()).toEqual(false);
    });
  } finally {
    result.unmount();
  }
});

test("SuggestionInput: reports that suggestions closed on Escape", async () => {
  const result = renderHarness();

  try {
    result.stdin.write("+pro");

    await waitFor(() => {
      expect(result.lastState()).toEqual(true);
      expect(result.lastFrame() ?? "").toMatch(/suggestions:2/);
    });

    result.stdin.write("\u001B");

    await waitFor(() => {
      expect(result.lastState()).toEqual(false);
      expect(result.lastFrame() ?? "").toMatch(/suggestions:0/);
    });
  } finally {
    result.unmount();
  }
});

test("SuggestionInput: reports that suggestions closed after applying one", async () => {
  const result = renderHarness();

  try {
    result.stdin.write("+pro");

    await waitFor(() => {
      expect(result.lastState()).toEqual(true);
      expect(result.lastFrame() ?? "").toMatch(/suggestions:2/);
    });

    result.stdin.write("\r");

    await waitFor(() => {
      expect(result.lastState()).toEqual(false);
      expect(result.lastFrame() ?? "").toMatch(/suggestions:0/);
    });

    expect(result.lastFrame() ?? "").toMatch(/project-a/);
  } finally {
    result.unmount();
  }
});

const FocusableProbe = ({ tag }: { tag: string }) => {
  const { id, isFocused } = useFocusable({ autoFocus: true, tag });

  return (
    <Text>{`${isFocused ? "focused" : "blurred"}:${id.description}`}</Text>
  );
};

test("useFocusable: keeps its focus identity stable when the tag prop changes", async () => {
  const result = render(
    <FocusProvider>
      <FocusableProbe tag="first-tag" />
    </FocusProvider>,
  );

  try {
    await waitFor(() => {
      expect(result.lastFrame() ?? "").toMatch(/focused:first-tag/);
    });

    result.rerender(
      <FocusProvider>
        <FocusableProbe tag="second-tag" />
      </FocusProvider>,
    );

    await waitFor(() => {
      expect(result.lastFrame() ?? "").toMatch(/focused:first-tag/);
    });
  } finally {
    result.unmount();
  }
});
