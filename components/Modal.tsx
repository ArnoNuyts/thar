import React, { ReactNode } from "react";
import { Box, Text } from "ink";

interface ModalProps {
  children: ReactNode;
  isFocused?: boolean;
  title?: string;
  width?: number | string;
}

export const Modal = ({ children, isFocused = true, title, width = "50%" }: ModalProps) => {
  return (
    <Box
      position="absolute"
      width="100%"
      height="100%"
      alignItems="center"
      justifyContent="center"
    >
      <Box flexDirection="column" width={width}>
        {title && <Text color="green">{title}</Text>}
        <Box
          borderStyle="round"
          borderColor={isFocused ? "green" : "gray"}
          flexDirection="column"
          backgroundColor="black"
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
};
