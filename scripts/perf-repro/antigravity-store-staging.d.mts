export function identity(path: string): string | null;
export interface StagingHooks {
  /** After the checks, before anything is copied. */
  beforeCopy?: () => void;
  /** After the copy, before the source is compared. */
  afterCopy?: () => void;
}
export function stageSummaries(
  source: string,
  target: string,
  hooks?: StagingHooks,
): { coherent: boolean };
export function stageConversation(
  source: string,
  target: string,
  id: string,
  hooks?: StagingHooks,
): { coherent: boolean; missing?: string[] };
export function assertContained(root: string): void;
