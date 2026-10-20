import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const stdAliases = {
  "@std/assert": resolve(import.meta.dirname, "test/assert.ts"),
  "@std/async": resolve(import.meta.dirname, "test/std-async.ts"),
  "@std/path": resolve(import.meta.dirname, "test/std-path.ts"),
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: stdAliases,
  },
  build: {
    ssr: "main.tsx",
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: "main.js",
      },
    },
  },
  ssr: {
    target: "node",
  },
  test: {
    environment: "node",
    include: ["unit-tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
    pool: "forks",
    fileParallelism: true,
    isolate: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: false,
    clearMocks: false,
    mockReset: false,
  },
});
