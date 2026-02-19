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
import { useEffect, useState } from "react";
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
  const [viewDate, setViewDate] = useState(startOfMonth(value));

  // Ensure viewDate tracks value if value changes externally and is far from viewDate
  // But we generally want to keep viewDate stable if user is just navigating days
  // So maybe only sync if value is completely different?
  // For now, let's just initialize viewDate from value.

  useInput((_input, key) => {
    if (!isFocused) return;

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
  });

  // Keep viewDate in sync with value if value moves out of view
  useEffect(() => {
    if (!isSameMonth(value, viewDate)) {
      setViewDate(startOfMonth(value));
    }
  }, [value]);

  const monthStart = startOfMonth(viewDate);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart, { weekStartsOn: 1 }); // Monday start
  const endDate = endOfWeek(monthEnd, { weekStartsOn: 1 });

  const days = eachDayOfInterval({
    start: startDate,
    end: endDate,
  });

  // Group days into weeks
  const weeks = [];
  let currentWeek = [];
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
