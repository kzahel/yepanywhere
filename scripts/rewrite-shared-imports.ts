/** Rewrite complete quoted module specifiers, including nested/dotted names. */
export function rewriteSharedImports(
  content: string,
  relativeEntry: string,
): string {
  return content.replace(
    /\b(from\s+|import\s*\(\s*|import\s*)(["'])@yep-anywhere\/shared(?:\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*))?\2/g,
    (_match, prefix: string, quote: string, subpath: string | undefined) => {
      // Shared's root and wildcard exports map to dist/index.js and
      // dist/<complete subpath>.js respectively. Never stop at a directory.
      const target = subpath
        ? relativeEntry.replace(/index\.js$/, `${subpath}.js`)
        : relativeEntry;
      return `${prefix}${quote}${target}${quote}`;
    },
  );
}
