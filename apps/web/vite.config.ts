import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is served from the same origin as the API in deployment
// (prd.md section 22.3). In development Vite proxies API paths to the kernel.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Object form keeps the browser Host header (the string shorthand implies changeOrigin), so the kernel sees
    // Origin and Host agree and browser mutations pass its same-origin CSRF check (apps/kernel/src/auth/operator.ts).
    proxy: {
      "/v1": { target: "http://127.0.0.1:8080", changeOrigin: false },
      "/health": { target: "http://127.0.0.1:8080", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
