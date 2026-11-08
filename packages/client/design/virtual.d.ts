declare module "virtual:ya-design-data" {
  import type { ButtonElement } from "./buttonFamilies";
  import type { DesignClassUsage } from "./vite-plugin-design-data";

  export const classUsage: Record<string, DesignClassUsage>;
  export const buttonElements: ButtonElement[];
}
