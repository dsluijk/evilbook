import { defineConfig } from "vite";

const SERVER = "http://localhost:8080";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": SERVER,
      "/ws": { target: SERVER, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
