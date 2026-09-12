import {
  findProjectPathTokens,
  type ProjectPathLinkTarget,
} from "@yep-anywhere/shared";
import type { ContentBlock } from "../types";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { readProjectPathLinkTargets } from "@yep-anywhere/shared/transcript/projectPathLinks";
import { getPathBasename } from "./text";

type RecentProjectPathLinks = Map<string, string>;

/** Most recent first; preserve full-path collisions and never scan unloaded history. */
export function recentProjectFileMentions(
  items: readonly RenderItem[],
): string[] {
  const recent = new Set<string>();
  const remember = (links: readonly ProjectPathLinkTarget[] | undefined) => {
    for (const link of links ?? []) {
      recent.delete(link.filePath);
      recent.add(link.filePath);
    }
  };
  for (const item of applyRecentProjectPathLinks([...items])) {
    if (item.type === "text") {
      remember(item.projectPathLinks);
      remember(linksFromRenderedHtml(item.augmentHtml));
    }
    if (item.type === "user_prompt") remember(item.projectPathLinks);
    if (item.type === "tool_call") {
      if (item.toolInput && typeof item.toolInput === "object") {
        remember(
          readProjectPathLinkTargets(
            (item.toolInput as Record<string, unknown>)._projectPathLinks,
          ),
        );
      }
      remember(item.toolResult?.projectPathLinks);
    }
  }
  return [...recent].reverse().slice(0, 100);
}

function contentText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is ContentBlock & { text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function shellCommand(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.command === "string") return record.command;
  return typeof record.cmd === "string" ? record.cmd : null;
}

function linksFromRenderedHtml(
  html: string | undefined,
): ProjectPathLinkTarget[] {
  if (
    !html?.includes('data-ya-resource="project-file"') ||
    typeof document === "undefined"
  ) {
    return [];
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  return Array.from(
    template.content.querySelectorAll<HTMLAnchorElement>(
      'a[data-ya-resource="project-file"][data-ya-path]',
    ),
  ).flatMap((anchor) => {
    const text = anchor.textContent?.trim();
    const filePath = anchor.dataset.yaPath;
    return text && filePath ? [{ filePath, text }] : [];
  });
}

function recentAliases(
  text: string,
  recent: ReadonlyMap<string, string>,
): ProjectPathLinkTarget[] {
  if (recent.size === 0) return [];
  const aliases = new Map<string, ProjectPathLinkTarget>();
  for (const token of findProjectPathTokens(text)) {
    const filePath = recent.get(token.text);
    if (!filePath) continue;
    aliases.set(token.text, { filePath, text: token.text });
  }
  return Array.from(aliases.values());
}

function rememberFullPathLinks(
  links: readonly ProjectPathLinkTarget[] | undefined,
  recent: RecentProjectPathLinks,
): void {
  if (!links) return;
  for (const link of links) {
    if (!link.text.includes("/") && !link.text.includes("\\")) continue;
    const basename = getPathBasename(link.filePath);
    if (basename && basename !== link.text) {
      recent.set(basename, link.filePath);
    }
  }
}

function replayBodyLinks(
  text: string,
  confirmed: readonly ProjectPathLinkTarget[] | undefined,
  recent: RecentProjectPathLinks,
): ProjectPathLinkTarget[] | undefined {
  const aliases = recentAliases(text, recent);
  rememberFullPathLinks(confirmed, recent);
  if (aliases.length === 0) return confirmed ? [...confirmed] : undefined;

  const links = new Map<string, ProjectPathLinkTarget>();
  for (const link of confirmed ?? []) links.set(link.text, link);
  for (const alias of aliases) links.set(alias.text, alias);
  return Array.from(links.values());
}

function sameLinks(
  left: readonly ProjectPathLinkTarget[] | undefined,
  right: readonly ProjectPathLinkTarget[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (link, index) =>
      link.text === right[index]?.text &&
      link.filePath === right[index]?.filePath,
  );
}

/** Add basename aliases using only project links from earlier replayed bodies. */
export function applyRecentProjectPathLinks(items: RenderItem[]): RenderItem[] {
  const recent: RecentProjectPathLinks = new Map();

  return items.map((item) => {
    if (item.type === "text") {
      const aliases = recentAliases(item.text, recent);
      rememberFullPathLinks(linksFromRenderedHtml(item.augmentHtml), recent);
      return aliases.length > 0 ? { ...item, projectPathLinks: aliases } : item;
    }

    if (item.type === "user_prompt") {
      const links = replayBodyLinks(
        contentText(item.content),
        item.projectPathLinks,
        recent,
      );
      return sameLinks(links, item.projectPathLinks)
        ? item
        : { ...item, projectPathLinks: links };
    }

    if (item.type !== "tool_call") return item;

    let toolInput = item.toolInput;
    const command = shellCommand(item.toolInput);
    if (command && item.toolInput && typeof item.toolInput === "object") {
      const input = item.toolInput as Record<string, unknown>;
      const confirmed = readProjectPathLinkTargets(input._projectPathLinks);
      const links = replayBodyLinks(command, confirmed, recent);
      if (!sameLinks(links, confirmed)) {
        toolInput = { ...input, _projectPathLinks: links };
      }
    }

    let toolResult = item.toolResult;
    if (toolResult) {
      const links = replayBodyLinks(
        toolResult.content,
        toolResult.projectPathLinks,
        recent,
      );
      if (!sameLinks(links, toolResult.projectPathLinks)) {
        toolResult = { ...toolResult, projectPathLinks: links };
      }
    }

    return toolInput === item.toolInput && toolResult === item.toolResult
      ? item
      : { ...item, toolInput, toolResult };
  });
}
