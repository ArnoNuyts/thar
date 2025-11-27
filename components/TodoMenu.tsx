import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useFocusedInput } from '../hooks/useFocusedInput.ts';
import { Modal } from './Modal.tsx';

export type MenuAction = 'edit' | 'delete' | 'toggle' | 'due' | 'threshold' | 'recurrence' | 'toggle-hidden';

interface TodoMenuProps {
    onSelect: (action: MenuAction) => void;
    onCancel: () => void;
}

interface MenuItem {
    label: string;
    shortcut: string;
    action: MenuAction;
}

const MENU_ITEMS: MenuItem[] = [
    { label: 'Edit', shortcut: 'e', action: 'edit' },
    { label: 'Delete', shortcut: 'del', action: 'delete' },
    { label: 'Toggle Complete', shortcut: 'space', action: 'toggle' },
    { label: 'Set Due Date', shortcut: 'd', action: 'due' },
    { label: 'Set Threshold Date', shortcut: 't', action: 'threshold' },
    { label: 'Set Recurrence', shortcut: 'r', action: 'recurrence' },
    { label: 'Toggle Hidden', shortcut: 'h', action: 'toggle-hidden' },
];

export const TodoMenu = ({ onSelect, onCancel }: TodoMenuProps) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    const { isFocused } = useFocusedInput((input, key) => {
        if (key.escape) {
            onCancel();
            return;
        }

        if (key.return) {
            onSelect(MENU_ITEMS[selectedIndex].action);
            return;
        }

        if (key.upArrow) {
            setSelectedIndex((prev: number) => (prev > 0 ? prev - 1 : MENU_ITEMS.length - 1));
            return;
        }

        if (key.downArrow) {
            setSelectedIndex((prev: number) => (prev < MENU_ITEMS.length - 1 ? prev + 1 : 0));
            return;
        }
        
        // Shortcut handling
        if (input === 'e') onSelect('edit');
        if (input === 'd') onSelect('due'); // Conflict with 'del' if typed fast? No, 'del' is not a single char. 'd' is due.
        // Actually 'del' is usually delete key, but here it says 'del' text. 
        // Let's assume 'delete' key triggers delete action too?
        if (key.delete) onSelect('delete');
        if (input === ' ') onSelect('toggle');
        if (input === 't') onSelect('threshold');
        if (input === 'r') onSelect('recurrence');
        if (input === 'h') onSelect('toggle-hidden');

    }, { autoFocus: true });

    return (
        // @ts-ignore: children prop issue
        <Modal isFocused={isFocused}>
            <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1}>
                <Box justifyContent="center" marginBottom={1}>
                    <Text>| Todo menu |</Text>
                </Box>
                {MENU_ITEMS.map((item, index) => (
                    <Box key={item.action}>
                        <Box width={6} justifyContent="end">
                            <Text color="yellow">{item.shortcut} </Text>
                        </Box>
                        <Box>
                            <Text
                                backgroundColor={index === selectedIndex ? 'blue' : undefined}
                                color={index === selectedIndex ? 'white' : undefined}
                            >
                                {item.label}
                            </Text>
                        </Box>
                    </Box>
                ))}
            </Box>
        </Modal>
    );
};
