/** The browser storage address for a draft belonging to one account. */
export function accountDraftStorageKey(
  key: string,
  owner: string | null,
): string {
  return owner ? `draft-account:${encodeURIComponent(owner)}:${key}` : key;
}

export const draftAccountOwners = new Map<string, string>();

export function draftAccountOwner(source: string): string | undefined {
  return (
    draftAccountOwners.get(source) ??
    localStorage.getItem(`draft-owner:${encodeURIComponent(source)}`) ??
    undefined
  );
}

export function draftPhysicalStorageKey(
  key: string,
  address: { source: string; slot: { kind: string } },
): string {
  const owner =
    draftAccountOwners.get(address.source) ??
    localStorage.getItem(`draft-owner:${encodeURIComponent(address.source)}`);
  const sourceKey =
    address.slot.kind === "handoff" && address.source !== "local"
      ? `draft-source:${encodeURIComponent(address.source)}:${key}`
      : key;
  return accountDraftStorageKey(sourceKey, owner);
}
