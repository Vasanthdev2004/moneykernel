import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is served from the same origin as the API in deployment
// (prd.md section 22.3). In development Vite proxies API paths to the kernel.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": "http://127.0.0.1:8080",
      "/health": "http://127.0.0.1:8080",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
