import {
  findProjectPathTokens,
  type ProjectPathLinkTarget,
} from "@yep-anywhere/shared";

export interface AnnotatedProjectPathLinksHtml {
  changed: boolean;
  html: string;
}

function setProjectPathAnchorTarget(
  anchor: HTMLAnchorElement,
  projectId: string,
  filePath: string,
): void {
  const params = new URLSearchParams({ path: filePath });
  anchor.setAttribute(
    "href",
    `/projects/${encodeURIComponent(projectId)}/file?${params}`,
  );
  anchor.dataset.yaResource = "project-file";
  anchor.dataset.yaProjectId = projectId;
  anchor.dataset.yaPath = filePath;
  anchor.dataset.yaPrivateProjectFileLink = "true";
  anchor.title = `${filePath}\nClick to view, or use a browser link gesture to open this file`;
}

/** Link basename occurrences inside one already-sanitized HTML fragment. */
export function annotateProjectPathLinksHtml(
  html: string,
  links: readonly ProjectPathLinkTarget[] | undefined,
  projectId: string | undefined,
): AnnotatedProjectPathLinksHtml {
  if (
    !html ||
    !links?.length ||
    !projectId ||
    typeof document === "undefined"
  ) {
    return { changed: false, html };
  }

  const targets = new Map(links.map((link) => [link.text, link.filePath]));
  const template = document.createElement("template");
  template.innerHTML = html;
  let changed = false;

  for (const anchor of template.content.querySelectorAll<HTMLAnchorElement>(
    'a[data-ya-resource="project-file"]',
  )) {
    const filePath = targets.get(anchor.textContent?.trim() ?? "");
    if (!filePath) continue;
    setProjectPathAnchorTarget(anchor, projectId, filePath);
    changed = true;
  }

  const walker = document.createTreeWalker(
    template.content,
    NodeFilter.SHOW_TEXT,
  );
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if (
      node instanceof Text &&
      !node.parentElement?.closest("a,button,script,style,textarea")
    ) {
      textNodes.push(node);
    }
    node = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const matches = findProjectPathTokens(textNode.data).filter((token) =>
      targets.has(token.text),
    );
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index];
      if (!match) continue;
      const suffix = textNode.splitText(match.end);
      const matched = textNode.splitText(match.start);
      const anchor = document.createElement("a");
      setProjectPathAnchorTarget(anchor, projectId, targets.get(match.text)!);
      matched.replaceWith(anchor);
      anchor.append(matched);
      void suffix;
      changed = true;
    }
  }

  return { changed, html: changed ? template.innerHTML : html };
}
