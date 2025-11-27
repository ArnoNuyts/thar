import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useFocusedInput } from '../hooks/useFocusedInput.ts';
import { Modal } from './Modal.tsx';

interface CreateTodoModalProps {
    onSave: (text: string) => void;
    onCancel: () => void;
}

export const CreateTodoModal = ({ onSave, onCancel }: CreateTodoModalProps) => {
    const [text, setText] = useState('');

    const { isFocused } = useFocusedInput((_input, key) => {
        if (key.escape) {
            onCancel();
        }
    }, { autoFocus: true });

    return (
        // @ts-ignore: children prop issue
        <Modal isFocused={isFocused}>
            <Text>Create new todo:</Text>
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
