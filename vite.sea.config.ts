import { defineConfig, mergeConfig } from "vite";
import baseConfig from "./vite.config.ts";
import pkg from "./package.json" with { type: "json" };

export default mergeConfig(
  baseConfig,
  defineConfig({
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
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
