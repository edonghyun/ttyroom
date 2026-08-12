import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const serverOrigin = loadEnv(mode, ".", "").VITE_TTYROOM_SERVER_ORIGIN;

  return {
    plugins: [react()],
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: "xterm", test: /node_modules\/@xterm\// },
              { name: "react", test: /node_modules\/(?:react|react-dom|scheduler)\// },
              { name: "icons", test: /node_modules\/react-feather\// },
            ],
          },
        },
      },
    },
    server: {
      proxy: serverOrigin
        ? {
            "/api": serverOrigin,
            "/ws": { target: serverOrigin, ws: true },
          }
        : undefined,
    },
  };
});
