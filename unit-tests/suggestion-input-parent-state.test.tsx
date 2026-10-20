import { render } from "ink-testing-library";
import { assertEquals, assertMatch } from "@std/assert";
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

Deno.test(
  "SuggestionInput: reports suggestion state while typing",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const result = renderHarness();

    try {
      result.stdin.write("+pro");

      await waitFor(() => {
        assertEquals(result.lastState(), true);
        assertMatch(result.lastFrame() ?? "", /suggestions:2/);
      });

      // Removing the tag prefix means there is no word start anymore.
      result.stdin.write("\x7f");
      result.stdin.write("\x7f");
      result.stdin.write("\x7f");
      result.stdin.write("\x7f");

      await waitFor(() => {
        assertEquals(result.lastState(), false);
      });
    } finally {
      result.unmount();
    }
  },
);

Deno.test(
  "SuggestionInput: reports that suggestions closed on Escape",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const result = renderHarness();

    try {
      result.stdin.write("+pro");

      await waitFor(() => {
        assertEquals(result.lastState(), true);
        assertMatch(result.lastFrame() ?? "", /suggestions:2/);
      });

      result.stdin.write("\u001B");

      await waitFor(() => {
        assertEquals(result.lastState(), false);
        assertMatch(result.lastFrame() ?? "", /suggestions:0/);
      });
    } finally {
      result.unmount();
    }
  },
);

Deno.test(
  "SuggestionInput: reports that suggestions closed after applying one",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const result = renderHarness();

    try {
      result.stdin.write("+pro");

      await waitFor(() => {
        assertEquals(result.lastState(), true);
        assertMatch(result.lastFrame() ?? "", /suggestions:2/);
      });

      result.stdin.write("\r");

      await waitFor(() => {
        assertEquals(result.lastState(), false);
        assertMatch(result.lastFrame() ?? "", /suggestions:0/);
      });

      assertMatch(result.lastFrame() ?? "", /project-a/);
    } finally {
      result.unmount();
    }
  },
);

const FocusableProbe = ({ tag }: { tag: string }) => {
  const { id, isFocused } = useFocusable({ autoFocus: true, tag });

  return (
    <Text>{`${isFocused ? "focused" : "blurred"}:${id.description}`}</Text>
  );
};

Deno.test(
  "useFocusable: keeps its focus identity stable when the tag prop changes",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const result = render(
      <FocusProvider>
        <FocusableProbe tag="first-tag" />
      </FocusProvider>,
    );

    try {
      await waitFor(() => {
        assertMatch(result.lastFrame() ?? "", /focused:first-tag/);
      });

      result.rerender(
        <FocusProvider>
          <FocusableProbe tag="second-tag" />
        </FocusProvider>,
      );

      await waitFor(() => {
        assertMatch(result.lastFrame() ?? "", /focused:first-tag/);
      });
    } finally {
      result.unmount();
    }
  },
);
