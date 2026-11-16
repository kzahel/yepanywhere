import { EMPTY_DRAFT, mergeDrafts } from "@yep-anywhere/shared";
import { draftAccountOwner } from "./draftAccountStorage";
import {
  draftAddress,
  draftStorage,
  draftPayloadFromStorage,
  draftPayloadToStorage,
} from "./draftSyncStorage";

export function readDraftAccountState(key: string) {
  try {
    const address = draftAddress(key);
    return {
      owner: address ? draftAccountOwner(address.source) : undefined,
      physicalKey: draftStorage.physicalKey(key),
    };
  } catch {
    return { owner: null, physicalKey: key };
  }
}

/** Only a field hydrated empty and edited before its first account may adopt. */
export function adoptInitialAccountDraft(
  key: string,
  previousPhysicalKey: string,
  text: string,
): string {
  const address = draftAddress(key);
  if (!address) return text;
  let previous: string | null = null;
  let current: string | null = null;
  try {
    previous = localStorage.getItem(previousPhysicalKey);
    current = draftStorage.getItem(key);
  } catch {}
  const local = draftPayloadFromStorage(address, previous);
  local.fields.text = text;
  const merged = mergeDrafts(
    EMPTY_DRAFT,
    local,
    draftPayloadFromStorage(address, current),
  );
  const raw = draftPayloadToStorage(address, merged, current);
  try {
    if (raw !== null) draftStorage.setItem(key, raw);
    if (localStorage.getItem(previousPhysicalKey) === previous)
      localStorage.removeItem(previousPhysicalKey);
  } catch {
    // A storage failure cannot erase text already held by the editor.
  }
  return merged.fields.text ?? "";
}
