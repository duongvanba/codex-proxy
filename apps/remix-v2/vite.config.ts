import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { NextRoutingStyle } from "./helpers/NextRoutingStyle";

export default defineConfig({
  envPrefix: "PUBLIC_",
  server: {
    host: "0.0.0.0",
    port: 3000,
    proxy: {
      // Forward API calls to Bun backend in dev. Realtime WS (9879) KHÔNG đi proxy —
      // browser kết nối thẳng tới gateway (xem helpers/livequery-client.ts).
      "/livequery": {
        target: "http://localhost:9878",
        changeOrigin: true,
      },
      "/v1": {
        target: "http://localhost:9878",
        changeOrigin: true,
      },
      "/backend-api": {
        target: "http://localhost:9878",
        changeOrigin: true,
      },
    },
  },
  plugins: [
    remix({
      ssr: false,
      routes: (d) =>
        d(async (r) => {
          const resolver = new NextRoutingStyle("app");
          const routes = resolver.build_routes();
          resolver.apply_routes(routes, r);
        }),
    }),
    tsconfigPaths({ ignoreConfigErrors: true }),
  ],
});
