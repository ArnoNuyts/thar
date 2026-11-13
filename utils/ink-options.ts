/**
 * Ink render options that affect perceived responsiveness.
 *
 * Shared with `scripts/benchmark-list.tsx` so the benchmark measures the same
 * configuration the app ships. Ink defaults to 30 fps, which holds burst input
 * for a frame window even though this UI has no animations and every render is
 * already driven by user input or file changes.
 */
export const INK_PERFORMANCE_OPTIONS = {
  incrementalRendering: true,
  maxFps: 120,
} as const;
