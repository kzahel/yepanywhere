import {
  fromUrlProjectId,
  isUrlProjectId,
  parseLocalResourceHref,
  parseLocalResourceLink,
  projectFileLink,
  splitTrailingCitedPosition,
  type ProjectFileLinks,
} from "@yep-anywhere/shared";
import type { MarkdownSelectionSnippet } from "./markdownSelectionCopy";
import { getProjectRelativePath, isAbsoluteLikePath } from "./text";

export interface CopyProjectFile {
  projectId: string;
  path: string;
  localPath: string;
  fragment: string;
}

interface CopyReference {
  start: number;
  end: number;
  file: CopyProjectFile;
  label?: string;
}

export interface PublicMarkdownCopy {
  source: string;
  references: CopyReference[];
}

export function copyFileKey(file: CopyProjectFile): string {
  return JSON.stringify([file.projectId, file.path]);
}

/** Recover project paths from both rendered autolinks and authored viewer URLs. */
export function preparePublicMarkdownCopy(
  snippets: readonly MarkdownSelectionSnippet[],
  projects: readonly { id: string; path: string }[],
  currentHref: string,
): PublicMarkdownCopy {
  const roots = [...projects].sort((a, b) => b.path.length - a.path.length);
  const references: CopyReference[] = [];
  const viewerUrl = (href: string): URL | null => {
    try {
      const url = new URL(href, currentHref);
      if (url.searchParams.has("rev")) return null;
      return url.origin === new URL(currentHref).origin ||
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.hostname.endsWith(".localhost")
        ? url
        : null;
    } catch {
      return null;
    }
  };
  let source = "";
  for (const snippet of snippets) {
    if (source) source += "\n\n";
    const offset = source.length;
    source += snippet.markdown;
    const known = new Map<string, CopyProjectFile>();
    const resolve = (
      value: string,
      projectId?: string,
    ): CopyProjectFile | null => {
      let path = value;
      let fragment = "";
      // Only our viewer routes and loopback viewer links describe this source.
      if (/^https?:\/\//i.test(value)) {
        if (!viewerUrl(value)) return null;
      }
      const local = parseLocalResourceHref(value, { currentHref });
      if (local) {
        if (new URL(value, currentHref).searchParams.has("rev")) return null;
        fragment = new URL(value, currentHref).hash.slice(1);
        path = local.path;
        projectId = local.projectId ?? projectId;
        if (local.lineNumber && !fragment)
          fragment = `L${local.lineNumber}${local.lineEnd ? `-L${local.lineEnd}` : ""}`;
      } else {
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return null;
        const hash = path.indexOf("#");
        if (hash >= 0) {
          fragment = path.slice(hash + 1);
          path = path.slice(0, hash);
        }
        const cited = splitTrailingCitedPosition(path);
        if (cited) {
          path = cited.path;
          fragment ||= `L${cited.position.lineNumber}${cited.position.lineEnd ? `-L${cited.position.lineEnd}` : ""}`;
        }
      }
      let project = roots.find(
        (entry) =>
          isAbsoluteLikePath(path) &&
          getProjectRelativePath(path, entry.path) !== null,
      );
      if (!project && projectId && isUrlProjectId(projectId)) {
        project = { id: projectId, path: fromUrlProjectId(projectId) };
      }
      if (!project) return null;
      const relative = isAbsoluteLikePath(path)
        ? getProjectRelativePath(path, project.path)
        : path.replace(/^\.\//, "");
      if (
        !relative ||
        relative
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      )
        return null;
      return {
        projectId: project.id,
        path: relative,
        localPath: `${project.path}/${relative}`,
        fragment,
      };
    };
    for (const anchor of snippet.sourceElement.querySelectorAll<HTMLAnchorElement>(
      "a[href]",
    )) {
      const href = anchor.getAttribute("href")!;
      if (!viewerUrl(href)) continue;
      const resource = parseLocalResourceLink(
        {
          href,
          attributes: Object.fromEntries(
            Array.from(anchor.attributes, (attr) => [attr.name, attr.value]),
          ),
        },
        { currentHref },
      );
      const file = resource
        ? resolve(resource.path, resource.projectId)
        : resolve(href);
      if (!file) continue;
      file.fragment ||= new URL(href, currentHref).hash.slice(1);
      const position = resource?.lineNumber;
      if (position && !file.fragment)
        file.fragment = `L${position}${resource?.lineEnd ? `-L${resource.lineEnd}` : ""}`;
      known.set(href, file);
      known.set(file.localPath, file);
      known.set(file.path, file);
      const label = anchor.textContent?.trim();
      if (label && /[/\\.]|^~/.test(label)) known.set(label, file);
    }
    const markdown = snippet.markdown;
    // Fences, inline code, links and bare paths are consumed once, in source order.
    const tokens =
      /(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\2[^\n]*(?:\n|$)|(?![\s\S])))|(!?\[(?:\\.|[^\]\\\n]|\[[^\]\n]*\])*\]\(\s*(?:<[^>\n]+>|(?:\\.|[^\s()\\]|\([^()\n]*\))+)(?:\s+["'][^\n]*?["'])?\s*\))|(`+)([^`\n]+)\4|^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(?:<[^>\n]+>|(?:\\.|[^\s()\\]|\([^()\n]*\))+)(?:[ \t]+["'][^\n]*?["'])?|(?:~\/|\/(?!\/)|[A-Za-z]:[\\/])[^\s<>`"']+|[^\s<>`"'()[\]]+\/[^ \s<>`"'()[\]]+/gm;
    for (const match of markdown.matchAll(tokens)) {
      if (match[1]) continue;
      let text = match[0];
      let label: string | undefined;
      let start = match.index;
      let end = start + text.length;
      const definition = /^[ \t]*\[[^\]\n]+\]:/.test(text);
      if (match[3] || definition) {
        if (text.startsWith("!")) continue;
        const boundary = definition
          ? text.indexOf("]:")
          : text.lastIndexOf("](");
        const destination = /^\s*(<[^>]+>|(?:\\.|[^\s()\\]|\([^()]*\))+)/.exec(
          text.slice(boundary + 2),
        );
        if (!destination) continue;
        const raw = destination[1]!;
        const leading = destination[0].length - raw.length;
        start += boundary + 2 + leading;
        end = start + raw.length;
        text = raw.startsWith("<") ? raw.slice(1, -1) : raw;
        text = text.replace(/\\([\\()[\]])/g, "$1");
      } else if (match[4]) {
        text = match[5]!;
        if (!known.has(text) && !isAbsoluteLikePath(text)) continue;
        label = match[0];
      } else {
        text = text.replace(/[.,;:!?]+$/, "");
        end = start + text.length;
        label = text;
      }
      const file =
        known.get(text) ?? resolve(text, snippet.sourceLocation?.projectId);
      if (file)
        references.push({
          start: offset + start,
          end: offset + end,
          file,
          label,
        });
    }
  }
  return { source, references };
}

export function renderPublicMarkdownCopy(
  copy: PublicMarkdownCopy,
  apps: ReadonlyMap<string, ProjectFileLinks>,
  shares: ReadonlyMap<string, string> = new Map(),
): { markdown: string; unresolved: CopyProjectFile[]; appProjects: string[] } {
  const unresolved = new Map<string, CopyProjectFile>();
  const appProjects = new Set<string>();
  let markdown = "";
  let cursor = 0;
  for (const reference of copy.references) {
    const { file } = reference;
    const mapping = apps.get(file.projectId);
    const appUrl =
      mapping && projectFileLink(mapping, file.path, file.fragment);
    let url = appUrl || shares.get(copyFileKey(file));
    if (appUrl) appProjects.add(file.projectId);
    if (url && !appUrl && file.fragment) {
      const parsed = new URL(url);
      parsed.hash = file.fragment;
      url = parsed.href;
    }
    if (!url) unresolved.set(copyFileKey(file), file);
    const destination =
      url ?? `${file.localPath}${file.fragment ? `#${file.fragment}` : ""}`;
    const replacement =
      reference.label !== undefined
        ? url
          ? `[${reference.label}](<${destination}>)`
          : reference.label
        : `<${destination}>`;
    markdown += copy.source.slice(cursor, reference.start) + replacement;
    cursor = reference.end;
  }
  return {
    markdown: markdown + copy.source.slice(cursor),
    unresolved: [...unresolved.values()],
    appProjects: [...appProjects],
  };
}
