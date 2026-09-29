import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "e2e/visual",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
  },
});
