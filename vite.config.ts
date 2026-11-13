import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
