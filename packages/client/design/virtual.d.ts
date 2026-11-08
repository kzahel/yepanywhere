declare module "virtual:ya-design-data" {
  import type { DesignClassUsage } from "./vite-plugin-design-data";

  export const classUsage: Record<string, DesignClassUsage>;
}
