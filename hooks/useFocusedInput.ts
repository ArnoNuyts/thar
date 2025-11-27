import { useRef } from 'react';
import { useInput, Key } from 'ink';
import { useFocusable, UseFocusableOptions } from './useFocusable.ts';

export const useFocusedInput = (
    handler: (input: string, key: Key) => void,
    options: UseFocusableOptions = {}
) => {
    const { isFocused } = useFocusable(options);
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useInput((input, key) => {
        if (!isFocused) return;
        handlerRef.current(input, key);
    });

    return { isFocused };
};
