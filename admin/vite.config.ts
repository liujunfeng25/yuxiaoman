import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const repositoryEnv = loadEnv(mode, "..", "");
  const configuredApiBase = process.env.VITE_API_BASE_URL || repositoryEnv.VITE_API_BASE_URL;
  const configuredMapWebKey = process.env.VITE_TENCENT_MAP_WEB_KEY || repositoryEnv.VITE_TENCENT_MAP_WEB_KEY || "";
  const apiTarget = process.env.YUXIAOMAN_API_TARGET
    || repositoryEnv.YUXIAOMAN_API_TARGET
    || configuredApiBase?.replace(/\/api\/?$/u, "")
    || `http://${repositoryEnv.HOST || "127.0.0.1"}:${repositoryEnv.PORT || "8787"}`;

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_TENCENT_MAP_WEB_KEY": JSON.stringify(configuredMapWebKey),
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["admin.yuxiaomancs.com", "localhost", "127.0.0.1"],
      fs: { allow: [".."] },
      proxy: {
        "/api": apiTarget,
        "/assets/used-cars": apiTarget,
      },
    },
  };
});
