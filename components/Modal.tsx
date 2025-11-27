import React, { ReactNode } from 'react';
import { Box } from 'ink';

interface ModalProps {
    children: ReactNode;
    isFocused?: boolean;
    title?: string;
}

export const Modal = ({ children, isFocused = true }: ModalProps) => {
    return (
        <Box
            borderStyle="round"
            borderColor={isFocused ? "green" : "gray"}
            flexDirection="column"
            padding={1}
            width="50%"
        >
            {children}
        </Box>
    );
};
