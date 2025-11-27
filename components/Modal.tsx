import React, { ReactNode } from 'react';
import { Box, Text } from 'ink';

interface ModalProps {
    children: ReactNode;
    isFocused?: boolean;
    title?: string;
}

export const Modal = ({ children, isFocused = true, title }: ModalProps) => {
    return (
        <Box flexDirection="column" width="50%">
            {title && <Text color="green"> {title}</Text>}
            <Box
                borderStyle="round"
                borderColor={isFocused ? "green" : "gray"}
                flexDirection="column"
                padding={1}
            >
                {children}
            </Box>
        </Box>
    );
};
