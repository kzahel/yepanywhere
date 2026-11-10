declare module "virtual:ya-design-data" {
  import type { collectOpenCensus } from "./openCensus";
  export const openCensus: Awaited<ReturnType<typeof collectOpenCensus>>;
}
