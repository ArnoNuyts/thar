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
  subWeeks
} from 'date-fns';
import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';

interface CalendarProps {
    value: Date;
    onChange: (date: Date) => void;
    onSubmit: (date: Date) => void;
    isFocused: boolean;
}

export const Calendar: React.FC<CalendarProps> = ({ value, onChange, onSubmit, isFocused }) => {
    const [viewDate, setViewDate] = useState(startOfMonth(value));

    // Ensure viewDate tracks value if value changes externally and is far from viewDate
    // But we generally want to keep viewDate stable if user is just navigating days
    // So maybe only sync if value is completely different?
    // For now, let's just initialize viewDate from value.

    useInput((input, key) => {
        if (!isFocused) return;

        if (key.upArrow) {
            onChange(subWeeks(value, 1));
        } else if (key.downArrow) {
            onChange(addWeeks(value, 1));
        } else if (key.leftArrow) {
            onChange(subDays(value, 1));
        } else if (key.rightArrow) {
            onChange(addDays(value, 1));
        } else if (input === '<' || (key.shift && input === ',')) {
             setViewDate(subMonths(viewDate, 1));
        } else if (input === '>' || (key.shift && input === '.')) {
             setViewDate(addMonths(viewDate, 1));
        } else if (key.return) {
            onSubmit(value);
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
        <Box flexDirection="column" borderStyle="round" borderColor="gray" width={30}>
            <Box justifyContent="space-between" paddingX={1} marginBottom={1}>
                <Text>{'< '}</Text>
                <Text bold>{format(viewDate, 'MMMM yyyy')}</Text>
                <Text>{' >'}</Text>
            </Box>
            <Box marginBottom={1} paddingX={1}>
                {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((day) => (
                    <Box key={day} width={3} justifyContent="center">
                        <Text dimColor>{day}</Text>
                    </Box>
                ))}
            </Box>
            {weeks.map((week, weekIndex) => (
                <Box key={weekIndex} paddingX={1}>
                    {week.map((day) => {
                        const isSelected = isSameDay(day, value);
                        const isCurrentMonth = isSameMonth(day, viewDate);

                        return (
                            <Box key={day.toISOString()} width={3} justifyContent="center">
                                <Text
                                    backgroundColor={isSelected ? 'green' : undefined}
                                    color={isSelected ? 'black' : (isCurrentMonth ? 'white' : 'gray')}
                                    dimColor={!isCurrentMonth}
                                >
                                    {format(day, 'd').padStart(2, ' ')}
                                </Text>
                            </Box>
                        );
                    })}
                </Box>
            ))}
        </Box>
    );
};
