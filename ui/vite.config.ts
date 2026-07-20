import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/events": "http://127.0.0.1:8787",
      "/state": "http://127.0.0.1:8787",
      "/runs": {
        target: "http://127.0.0.1:8787",
        // /runs is both the JSON endpoint (fetch) and a SPA route (browser
        // navigation) — only proxy non-HTML requests so page loads/reloads of
        // /runs and /runs/$issueKey still serve the app shell.
        bypass: (req) =>
          req.headers.accept?.includes("text/html") ? "/index.html" : undefined,
      },
    },
  },
});
