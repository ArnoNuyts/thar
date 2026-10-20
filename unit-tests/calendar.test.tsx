import { assertEquals, assertMatch } from "@std/assert";
import { render } from "ink-testing-library";
import { useEffect, useState } from "react";
import { addDays, addMonths, format } from "date-fns";

import { Calendar } from "../components/Calendar.tsx";
import { waitFor } from "./test-utils.ts";

const BASE_DATE = new Date(2024, 0, 15); // 2024-01-15

type CalendarState = { value: Date };

function CalendarHarness({
  isFocused,
  onChange,
  onSubmit,
  state,
}: {
  isFocused: boolean;
  onChange?: (date: Date) => void;
  onSubmit?: (date: Date) => void;
  state?: CalendarState;
}) {
  const [value, setValue] = useState(BASE_DATE);

  useEffect(() => {
    if (state) state.value = value;
  }, [state, value]);

  return (
    <Calendar
      value={value}
      onChange={(date) => {
        setValue(date);
        onChange?.(date);
      }}
      onSubmit={onSubmit ?? (() => {})}
      isFocused={isFocused}
    />
  );
}

const tree = (
  isFocused: boolean,
  handlers: {
    onChange?: (date: Date) => void;
    onSubmit?: (date: Date) => void;
    state?: CalendarState;
  } = {},
) => <CalendarHarness isFocused={isFocused} {...handlers} />;

function ControlledCalendar({ value }: { value: Date }) {
  return (
    <Calendar
      value={value}
      onChange={() => {}}
      onSubmit={() => {}}
      isFocused={false}
    />
  );
}

Deno.test(
  "Calendar: ignores navigation keys while unfocused",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const changes: Date[] = [];
    const { stdin, rerender, unmount } = render(
      tree(false, { onChange: (date) => changes.push(date) }),
    );

    await stdin.write("\u001B[C"); // Right, ignored

    rerender(tree(true, { onChange: (date) => changes.push(date) }));

    await stdin.write("\u001B[C"); // Right, focused

    await waitFor(() => {
      assertEquals(changes.length, 1);
      assertEquals(
        format(changes[0], "yyyy-MM-dd"),
        format(addDays(BASE_DATE, 1), "yyyy-MM-dd"),
      );
    });

    unmount();
  },
);

Deno.test(
  "Calendar: focused navigation keeps day/week/month bindings",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const state: CalendarState = { value: BASE_DATE };
    const submitted: Date[] = [];
    const { stdin, unmount } = render(
      tree(true, {
        onSubmit: (date) => submitted.push(date),
        state,
      }),
    );

    await stdin.write("\u001B[B"); // Down: +1 week
    await waitFor(() => {
      assertEquals(
        format(state.value, "yyyy-MM-dd"),
        format(addDays(BASE_DATE, 7), "yyyy-MM-dd"),
      );
    });

    await stdin.write("\u001B[1;2C"); // Shift+Right: +1 month
    await waitFor(() => {
      assertEquals(
        format(state.value, "yyyy-MM-dd"),
        format(addMonths(addDays(BASE_DATE, 7), 1), "yyyy-MM-dd"),
      );
    });

    await stdin.write("\x1b[1;5D"); // Ctrl+Left: -1 month
    await waitFor(() => {
      assertEquals(
        format(state.value, "yyyy-MM-dd"),
        format(addDays(BASE_DATE, 7), "yyyy-MM-dd"),
      );
    });

    await stdin.write("\r");
    await waitFor(() => {
      assertEquals(submitted.length, 1);
      assertEquals(
        format(submitted[0], "yyyy-MM-dd"),
        format(addDays(BASE_DATE, 7), "yyyy-MM-dd"),
      );
    });

    unmount();
  },
);

Deno.test(
  "Calendar: rendered month follows value changes from props",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const { rerender, lastFrame, unmount } = render(
      <ControlledCalendar value={new Date(2024, 0, 15)} />,
    );

    await waitFor(() => assertMatch(lastFrame() || "", /January 2024/));

    // Moving the value outside the current month must move the view too.
    rerender(<ControlledCalendar value={new Date(2024, 2, 20)} />);
    await waitFor(() => assertMatch(lastFrame() || "", /March 2024/));

    // Crossing a year boundary works as well.
    rerender(<ControlledCalendar value={new Date(2025, 0, 3)} />);
    await waitFor(() => assertMatch(lastFrame() || "", /January 2025/));

    unmount();
  },
);

Deno.test(
  "Calendar: month navigation updates the rendered month",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const state: CalendarState = { value: BASE_DATE };
    const { stdin, lastFrame, unmount } = render(tree(true, { state }));

    await waitFor(() => assertMatch(lastFrame() || "", /January 2024/));

    await stdin.write("\u001B[1;2C"); // Shift+Right: +1 month
    await waitFor(() => {
      assertEquals(format(state.value, "yyyy-MM-dd"), "2024-02-15");
      assertMatch(lastFrame() || "", /February 2024/);
    });

    // Day navigation inside the visible month keeps the same view.
    await stdin.write("\u001B[C"); // Right: +1 day
    await waitFor(() => {
      assertEquals(format(state.value, "yyyy-MM-dd"), "2024-02-16");
      assertMatch(lastFrame() || "", /February 2024/);
    });

    await stdin.write("\x1b[1;5D"); // Ctrl+Left: -1 month
    await waitFor(() => assertMatch(lastFrame() || "", /January 2024/));

    await stdin.write("\u001B[1;2D"); // Shift+Left: -1 month
    await waitFor(() => assertMatch(lastFrame() || "", /December 2023/));

    unmount();
  },
);
