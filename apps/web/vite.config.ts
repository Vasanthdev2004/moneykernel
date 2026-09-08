import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const kernelOrigin = `http://127.0.0.1:${process.env.E2E_KERNEL_PORT ?? "8080"}`;

// The dashboard is served from the same origin as the API in deployment
// (prd.md section 22.3). In development Vite proxies API paths to the kernel.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.E2E_WEB_PORT ?? 5173),
    strictPort: true,
    // Object form keeps the browser Host header (the string shorthand implies changeOrigin), so the kernel sees
    // Origin and Host agree and browser mutations pass its same-origin CSRF check (apps/kernel/src/auth/operator.ts).
    proxy: {
      "/v1": { target: kernelOrigin, changeOrigin: false },
      "/health": { target: kernelOrigin, changeOrigin: false },
      "/metrics": { target: kernelOrigin, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: process.env.SOURCE_MAPS === "true",
  },
});
