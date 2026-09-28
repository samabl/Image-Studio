import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发时固定端口，方便 tauri.conf.json 里的 devUrl 匹配
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // src-tauri 由 cargo 自己监听，避免 vite 重复触发
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Android WebView / 旧版 WebView2 兼容
    target: "es2021",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
