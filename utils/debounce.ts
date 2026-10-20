export type DebouncedFunction<Args extends unknown[]> = {
  (...args: Args): void;
  clear(): void;
};

/**
 * Delays `fn` until `wait` milliseconds have passed without another call.
 * A pending call can be cancelled with `clear()`.
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  wait = 0,
): DebouncedFunction<Args> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced: DebouncedFunction<Args> = (...args) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void fn(...args);
    }, wait);
  };

  debounced.clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return debounced;
}
