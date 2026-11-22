export function identity(path: string): string | null;
export function stageSummaries(
  source: string,
  target: string,
  afterCopy?: () => void,
): { coherent: boolean };
export function stageConversation(
  source: string,
  target: string,
  id: string,
  afterCopy?: () => void,
): { coherent: boolean };
export function assertContained(root: string): void;
