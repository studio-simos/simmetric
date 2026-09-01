import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import cssInjectedByJs from "vite-plugin-css-injected-by-js";
import path from "path";

export default defineConfig({
  plugins: [preact(), cssInjectedByJs()],
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
    },
  },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  build: {
    outDir: "dist-widget",
    lib: {
      entry: path.resolve(__dirname, "src/widget/index.tsx"),
      name: "SimmetricChatWidget",
      formats: ["iife"],
      fileName: () => "app.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    // Target modern browsers for smaller bundle
    target: "es2020",
    // Minify for production
    minify: "esbuild",
  },
});