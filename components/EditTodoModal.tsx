import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useFocusedInput } from '../hooks/useFocusedInput.ts';
import { Modal } from './Modal.tsx';

interface EditTodoModalProps {
    initialValue: string;
    onSave: (text: string) => void;
    onCancel: () => void;
}

export const EditTodoModal = ({ initialValue, onSave, onCancel }: EditTodoModalProps) => {
    const [text, setText] = useState(initialValue);

    const { isFocused } = useFocusedInput((_input, key) => {
        if (key.escape) {
            onCancel();
        }
    }, { autoFocus: true });

    return (
        // @ts-ignore: children prop issue
        <Modal isFocused={isFocused}>
            <Text>Edit todo:</Text>
            <Box>
                <Text color="green">» </Text>
                <TextInput
                    focus={isFocused}
                    value={text}
                    onChange={setText}
                    onSubmit={onSave}
                />
            </Box>
            <Text dimColor>Enter = save, Esc = cancel</Text>
        </Modal>
    );
};
