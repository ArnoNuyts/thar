import { defineConfig, mergeConfig } from "vite";
import baseConfig from "./vite.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    build: {
      outDir: "dist-sea",
      emptyOutDir: true,
      minify: true,
      sourcemap: false,
      rollupOptions: {
        output: {
          entryFileNames: "main.mjs",
          codeSplitting: false,
        },
      },
    },
    ssr: {
      target: "node",
      noExternal: true,
    },
  }),
);
