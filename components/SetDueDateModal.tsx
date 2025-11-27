import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useFocusedInput } from '../hooks/useFocusedInput.ts';
import { Modal } from './Modal.tsx';

interface SetDueDateModalProps {
    onSave: (date: Date) => void;
    onCancel: () => void;
}

const OPTIONS = [
    { label: 'Today', value: 'today' },
    { label: 'Tomorrow', value: 'tomorrow' },
    { label: 'Next Week', value: 'next-week' },
    { label: 'Next Month', value: 'next-month' },
    { label: 'Custom', value: 'custom' },
];

export const SetDueDateModal = ({ onSave, onCancel }: SetDueDateModalProps) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isCustom, setIsCustom] = useState(false);
    const [customDate, setCustomDate] = useState(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-`;
    });

    const { isFocused } = useFocusedInput((_input, key) => {
        if (key.escape) {
            if (isCustom) {
                setIsCustom(false);
            } else {
                onCancel();
            }
            return;
        }

        if (isCustom) return; // Let TextInput handle input when custom is active

        if (key.return) {
            const selected = OPTIONS[selectedIndex];
            if (selected.value === 'custom') {
                setIsCustom(true);
            } else {
                const date = new Date();
                switch (selected.value) {
                    case 'today':
                        break;
                    case 'tomorrow':
                        date.setDate(date.getDate() + 1);
                        break;
                    case 'next-week':
                        date.setDate(date.getDate() + 7);
                        break;
                    case 'next-month':
                        date.setMonth(date.getMonth() + 1);
                        break;
                }
                onSave(date);
            }
            return;
        }

        if (key.upArrow) {
            setSelectedIndex((prev: number) => (prev > 0 ? prev - 1 : OPTIONS.length - 1));
            return;
        }

        if (key.downArrow) {
            setSelectedIndex((prev: number) => (prev < OPTIONS.length - 1 ? prev + 1 : 0));
            return;
        }
    }, { autoFocus: true });

    const handleCustomSubmit = (value: string) => {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
            onSave(date);
        }
    };

    return (
        // @ts-ignore: children prop issue
        <Modal isFocused={isFocused}>
            <Text>Set Due Date:</Text>
            {!isCustom ? (
                <Box flexDirection="column" paddingX={1}>
                    {OPTIONS.map((option, index) => {
                        return <Text
                            {...({ key: option.value } as any)}
                            backgroundColor={index === selectedIndex ? 'blue' : undefined}
                            color={index === selectedIndex ? 'white' : undefined}
                        >
                            {option.label}
                        </Text>;
                    })}
                </Box>
            ) : (
                <Box>
                    <Text color="green">Date (YYYY-MM-DD): </Text>
                    <TextInput
                        focus={isFocused}
                        value={customDate}
                        onChange={setCustomDate}
                        onSubmit={handleCustomSubmit}
                    />
                </Box>
            )}
        </Modal>
    );
};
