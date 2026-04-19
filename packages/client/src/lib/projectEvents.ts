const PROJECTS_CHANGED_EVENT = "yep-anywhere:projects-changed";

export function emitProjectsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
}

export function subscribeProjectsChanged(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  window.addEventListener(PROJECTS_CHANGED_EVENT, listener);
  return () => {
    window.removeEventListener(PROJECTS_CHANGED_EVENT, listener);
  };
}
