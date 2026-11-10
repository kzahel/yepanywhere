/** Stable Modal boundaries and the legacy selectors retained during migration. */
export function reachesModalFrame(
  selector: string,
  isModule: boolean,
): boolean {
  if (
    /\[\s*data-modal-(?:frame|overlay(?:-(?:anchored|image-viewer))?|header(?:-actions)?|content|title|close|anchored|image-viewer)\s*(?:[~|^$*]?=|\])/.test(
      selector,
    )
  ) {
    return true;
  }
  return isModule
    ? /:global(?:\((?:[^()]|\([^()]*\))*?|\s+[^()]*?)\.modal(?:-[\w-]+)?(?![\w-])/.test(
        selector,
      )
    : /\.modal(?:-[\w-]+)?:has\(/.test(selector);
}
