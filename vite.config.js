import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: ".",
  publicDir: "public",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@api": path.resolve(__dirname, "src/api"),
      "@assets": path.resolve(__dirname, "src/assets"),
      "@components": path.resolve(__dirname, "src/components"),
      "@config": path.resolve(__dirname, "src/config"),
      "@layout": path.resolve(__dirname, "src/layout"),
      "@mock": path.resolve(__dirname, "src/mock"),
      "@router": path.resolve(__dirname, "src/router"),
      "@utils": path.resolve(__dirname, "src/utils"),
      "@views": path.resolve(__dirname, "src/views")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5191
  },
  build: {
    outDir: "dist",
    sourcemap: false
  }
});
