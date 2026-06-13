import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const DAEMON = process.env.TQ_DAEMON_URL ?? "http://127.0.0.1:7788";

// Dev server proxies the daemon REST + SSE so the web app is same-origin in dev.
// SSE works through the proxy because http-proxy streams responses and the
// daemon sets `X-Accel-Buffering: no`.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: DAEMON,
        changeOrigin: true,
      },
    },
  },
});
