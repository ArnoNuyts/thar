import { expect, test } from "vitest";

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

test("Calendar: ignores navigation keys while unfocused", async () => {
  const changes: Date[] = [];
  const { stdin, rerender, unmount } = render(
    tree(false, { onChange: (date) => changes.push(date) }),
  );

  await stdin.write("\u001B[C"); // Right, ignored

  rerender(tree(true, { onChange: (date) => changes.push(date) }));

  await stdin.write("\u001B[C"); // Right, focused

  await waitFor(() => {
    expect(changes.length).toEqual(1);
    expect(format(changes[0], "yyyy-MM-dd")).toEqual(
      format(addDays(BASE_DATE, 1), "yyyy-MM-dd"),
    );
  });

  unmount();
});

test("Calendar: focused navigation keeps day/week/month bindings", async () => {
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
    expect(format(state.value, "yyyy-MM-dd")).toEqual(
      format(addDays(BASE_DATE, 7), "yyyy-MM-dd"),
    );
  });

  await stdin.write("\u001B[1;2C"); // Shift+Right: +1 month
  await waitFor(() => {
    expect(format(state.value, "yyyy-MM-dd")).toEqual(
      format(addMonths(addDays(BASE_DATE, 7), 1), "yyyy-MM-dd"),
    );
  });

  await stdin.write("\x1b[1;5D"); // Ctrl+Left: -1 month
  await waitFor(() => {
    expect(format(state.value, "yyyy-MM-dd")).toEqual(
      format(addDays(BASE_DATE, 7), "yyyy-MM-dd"),
    );
  });

  await stdin.write("\r");
  await waitFor(() => {
    expect(submitted.length).toEqual(1);
    expect(format(submitted[0], "yyyy-MM-dd")).toEqual(
      format(addDays(BASE_DATE, 7), "yyyy-MM-dd"),
    );
  });

  unmount();
});

test("Calendar: rendered month follows value changes from props", async () => {
  const { rerender, lastFrame, unmount } = render(
    <ControlledCalendar value={new Date(2024, 0, 15)} />,
  );

  await waitFor(() => expect(lastFrame() || "").toMatch(/January 2024/));

  // Moving the value outside the current month must move the view too.
  rerender(<ControlledCalendar value={new Date(2024, 2, 20)} />);
  await waitFor(() => expect(lastFrame() || "").toMatch(/March 2024/));

  // Crossing a year boundary works as well.
  rerender(<ControlledCalendar value={new Date(2025, 0, 3)} />);
  await waitFor(() => expect(lastFrame() || "").toMatch(/January 2025/));

  unmount();
});

test("Calendar: month navigation updates the rendered month", async () => {
  const state: CalendarState = { value: BASE_DATE };
  const { stdin, lastFrame, unmount } = render(tree(true, { state }));

  await waitFor(() => expect(lastFrame() || "").toMatch(/January 2024/));

  await stdin.write("\u001B[1;2C"); // Shift+Right: +1 month
  await waitFor(() => {
    expect(format(state.value, "yyyy-MM-dd")).toEqual("2024-02-15");
    expect(lastFrame() || "").toMatch(/February 2024/);
  });

  // Day navigation inside the visible month keeps the same view.
  await stdin.write("\u001B[C"); // Right: +1 day
  await waitFor(() => {
    expect(format(state.value, "yyyy-MM-dd")).toEqual("2024-02-16");
    expect(lastFrame() || "").toMatch(/February 2024/);
  });

  await stdin.write("\x1b[1;5D"); // Ctrl+Left: -1 month
  await waitFor(() => expect(lastFrame() || "").toMatch(/January 2024/));

  await stdin.write("\u001B[1;2D"); // Shift+Left: -1 month
  await waitFor(() => expect(lastFrame() || "").toMatch(/December 2023/));

  unmount();
});
