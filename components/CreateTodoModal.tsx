import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useFocusedInput } from '../hooks/useFocusedInput.ts';
import { Modal } from './Modal.tsx';
import { useModal } from './modal-context.tsx';

interface CreateTodoModalProps {
    onSave: (text: string) => void;
}

export const CreateTodoModal = ({ onSave }: CreateTodoModalProps) => {
    const [text, setText] = useState('');
    const { closeModal } = useModal();

    const { isFocused } = useFocusedInput((_input, key) => {
        if (key.escape) {
            closeModal();
            return;
        }

        if (key.return) {
            if (text.trim().length > 0) {
                onSave(text);
            }
            closeModal();
            return;
        }
    }, { autoFocus: true });

    return (
        // @ts-ignore: children prop issue
        <Modal isFocused={isFocused} title="Create new todo">
            <Box>
                <Text color="green">» </Text>
                <TextInput
                    focus={isFocused}
                    value={text}
                    onChange={setText}
                />
            </Box>
            <Text dimColor>Enter = save, Esc = cancel</Text>
        </Modal>
    );
};
