import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [react()],
  resolve: {
    conditions: ["source"],
    // SessionListItem reaches the relay client through `api`; the app
    // build supplies the same browser substitute.
    alias: [
      {
        find: "crypto",
        replacement: fileURLToPath(
          new URL("../../src/lib/connection/browserCrypto.ts", import.meta.url),
        ),
      },
      {
        find: /^(?:\.\.\/hooks|\.)\/useVersion$/,
        replacement: fileURLToPath(
          new URL("./fixtureServices.ts", import.meta.url),
        ),
      },
    ],
  },
  build: {
    outDir: "../../../../.artifacts/mockups/inbox-provider-wait",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1024,
  },
});
