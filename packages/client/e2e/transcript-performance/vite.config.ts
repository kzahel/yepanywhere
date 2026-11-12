import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { warningFreeBuildLogger } from "../../vite-build-policy";

const root = fileURLToPath(new URL("../..", import.meta.url));
export default defineConfig({
  root,
  plugins: [react()],
  customLogger: warningFreeBuildLogger("Transcript benchmark"),
  define: {
    __APP_VERSION__: JSON.stringify("0.12.0"),
    __VITE_DEV_PORT__: "3422",
    __BACKEND_PORT__: "3420",
    "import.meta.env.VITE_DISABLE_ONBOARDING": JSON.stringify("true"),
    "import.meta.env.VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS":
      JSON.stringify("true"),
  },
  resolve: {
    conditions: ["source"],
    alias: [
      {
        find: /^.*\/ClientSummarySourceBinding$/,
        replacement: resolve(
          root,
          "e2e/transcript-performance/sourceBinding.ts",
        ),
      },
      {
        find: "crypto",
        replacement: resolve(root, "src/lib/connection/browserCrypto.ts"),
      },
    ],
  },
  build: {
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      input: resolve(root, "e2e/transcript-performance/index.html"),
      output: {
        manualChunks: {
          english: [resolve(root, "src/i18n/en.json")],
          "file-viewer": [resolve(root, "src/components/FileViewer.tsx")],
          "source-security": [
            resolve(root, "src/lib/connection/SecureConnection.ts"),
          ],
          "tool-renderers": [
            resolve(root, "src/components/renderers/ContentBlockRenderer.tsx"),
          ],
          "message-list": [resolve(root, "src/components/MessageList.tsx")],
          composer: [resolve(root, "src/components/MessageInput.tsx")],
          "client-summary": [resolve(root, "src/lib/clientSummaryStore.ts")],
          "react-runtime": ["react", "react-dom/client"],
          katex: ["katex"],
        },
      },
    },
  },
});
