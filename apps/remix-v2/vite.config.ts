import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { NextRoutingStyle } from "./helpers/NextRoutingStyle";

export default defineConfig({
  envPrefix: "PUBLIC_",
  server: {
    host: "0.0.0.0",
    port: 9000,
    hmr: false,
    allowedHosts: ["opaip.amazingproxy.xyz", "codex", "codex.duyenruby.com"],
    proxy: {
      "/livequery/realtime-updates": {
        target: "http://192.168.2.4:9876",
        ws: true,
        changeOrigin: true,
      },
      // Forward API calls to Bun backend in dev.
      "/livequery": {
        target: "http://192.168.2.4:9876",
        changeOrigin: true,
      },
      "/auth-api": {
        target: "http://192.168.2.4:9876",
        changeOrigin: true,
      },
      "/v1": {
        target: "http://192.168.2.4:9876",
        changeOrigin: true,
      },
      "/backend-api": {
        target: "http://192.168.2.4:9876",
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
