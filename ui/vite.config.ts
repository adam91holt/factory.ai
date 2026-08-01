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
      "/telemetry": {
        target: "http://127.0.0.1:8787",
        // Same split as /runs below: /telemetry is both the JSON endpoint and
        // a SPA route, so HTML navigations must get the app shell.
        bypass: (req) =>
          req.headers.accept?.includes("text/html") ? "/index.html" : undefined,
      },
      "/runs": {
        target: "http://127.0.0.1:8787",
        // /runs is both the JSON endpoint (fetch) and a SPA route (browser
        // navigation) — only proxy non-HTML requests so page loads/reloads of
        // /runs and /runs/$issueKey still serve the app shell.
        bypass: (req) =>
          req.headers.accept?.includes("text/html") ? "/index.html" : undefined,
      },
      // /catalog is the JSON read endpoint AND the SPA route; /catalog/save is
      // the POST write. Same HTML-bypass split as /runs so a page load of
      // /catalog still serves the app shell, while fetch()/POST proxy through.
      "/catalog": {
        target: "http://127.0.0.1:8787",
        bypass: (req) =>
          req.method === "GET" && req.headers.accept?.includes("text/html") ? "/index.html" : undefined,
      },
      // /approvals is the JSON read endpoint AND the SPA route; /approvals/
      // approve + /approvals/pushback are the POST writes (inbox-backend
      // stream). Identical split to /catalog.
      "/approvals": {
        target: "http://127.0.0.1:8787",
        bypass: (req) =>
          req.method === "GET" && req.headers.accept?.includes("text/html") ? "/index.html" : undefined,
      },
      // /lessons is the JSON read endpoint AND the SPA route; /lessons/archive
      // is the POST write. Identical split to /catalog.
      "/lessons": {
        target: "http://127.0.0.1:8787",
        bypass: (req) =>
          req.method === "GET" && req.headers.accept?.includes("text/html") ? "/index.html" : undefined,
      },
    },
  },
});
