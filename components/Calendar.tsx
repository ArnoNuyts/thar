import {
  addDays,
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from "date-fns";
import { Box, Text } from "ink";
import { useInput } from "../hooks/useInput.ts";
import { useState } from "react";
import { COLORS } from "../theme/colors.ts";

interface CalendarProps {
  value: Date;
  onChange: (date: Date) => void;
  onSubmit: (date: Date) => void;
  isFocused: boolean;
}

export const Calendar: React.FC<CalendarProps> = (
  { value, onChange, onSubmit, isFocused },
) => {
  const [viewDate, setViewDate] = useState(() => startOfMonth(value));
  const [syncedValue, setSyncedValue] = useState(value);

  // When the selected value moves to a different month (month navigation or a
  // parent update), adjust the visible month during render. Doing this during
  // render instead of in an effect avoids committing a frame with the stale
  // month. Tracking the value that was last synced keeps `viewDate` free to be
  // paged independently within its month.
  if (!isSameMonth(value, syncedValue)) {
    setSyncedValue(value);
    setViewDate(startOfMonth(value));
  }

  useInput((_input, key) => {
    switch (true) {
      case key.upArrow:
        onChange(subWeeks(value, 1));
        break;
      case key.downArrow:
        onChange(addWeeks(value, 1));
        break;
      case key.leftArrow:
        if (key.shift || key.ctrl) {
          onChange(subMonths(value, 1));
        } else {
          onChange(subDays(value, 1));
        }
        break;
      case key.rightArrow:
        if (key.shift || key.ctrl) {
          onChange(addMonths(value, 1));
        } else {
          onChange(addDays(value, 1));
        }
        break;
      case key.return:
        onSubmit(value);
        break;
    }
  }, { isActive: isFocused });

  const monthStart = startOfMonth(viewDate);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart, { weekStartsOn: 1 }); // Monday start
  const endDate = endOfWeek(monthEnd, { weekStartsOn: 1 });

  const days = eachDayOfInterval({
    start: startDate,
    end: endDate,
  });

  // Group days into weeks
  const weeks: Date[][] = [];
  let currentWeek: Date[] = [];
  for (const day of days) {
    currentWeek.push(day);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  return (
    <Box flexDirection="column" width={24}>
      <Box justifyContent="center" marginBottom={1}>
        <Text bold>{format(viewDate, "MMMM yyyy")}</Text>
      </Box>
      <Box marginBottom={0}>
        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((day) => (
          <Box key={day} width={3} justifyContent="center">
            <Text dimColor>{day}</Text>
          </Box>
        ))}
      </Box>
      {weeks.map((week, weekIndex) => (
        <Box key={weekIndex}>
          {week.map((day) => {
            const isSelected = isSameDay(day, value);
            const isCurrentMonth = isSameMonth(day, viewDate);

            return (
              <Box key={day.toISOString()} width={3} justifyContent="center">
                <Text
                  backgroundColor={isSelected ? COLORS.success : undefined}
                  color={isSelected
                    ? COLORS.inverseForeground
                    : (isCurrentMonth ? COLORS.foreground : COLORS.muted)}
                  dimColor={!isCurrentMonth}
                >
                  {format(day, "d").padStart(2, " ")}
                </Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
};
