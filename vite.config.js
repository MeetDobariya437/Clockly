import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  root: "src",
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});

