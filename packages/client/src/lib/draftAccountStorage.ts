/** The browser storage address for a draft belonging to one account. */
export function accountDraftStorageKey(
  key: string,
  owner: string | null,
): string {
  return owner ? `draft-account:${encodeURIComponent(owner)}:${key}` : key;
}

export function draftPhysicalStorageKey(
  key: string,
  address: { source: string; slot: { kind: string } },
  owners: ReadonlyMap<string, string>,
): string {
  const owner =
    owners.get(address.source) ??
    localStorage.getItem(`draft-owner:${encodeURIComponent(address.source)}`);
  const sourceKey =
    address.slot.kind === "handoff" && address.source !== "local"
      ? `draft-source:${encodeURIComponent(address.source)}:${key}`
      : key;
  return accountDraftStorageKey(sourceKey, owner);
}
