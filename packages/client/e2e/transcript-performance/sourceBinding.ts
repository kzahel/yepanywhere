/**
 * The fixture pins the local source before mounting App. Its normal route source
 * binding would replace the fake with a network transport; keep that selection
 * effect outside this renderer benchmark. No rendered component is substituted.
 */
export function ClientSummarySourceBinding(): null {
  return null;
}
