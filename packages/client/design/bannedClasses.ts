/** Retired classes stay banned independently of playground pages or CSS rules. */
import allowlist from "./census/button-allowlist.json";

const pattern = new RegExp(
  `(?<![\\w-])(?:${allowlist.bannedClasses.join("|")})(?![\\w-])`,
  "g",
);

export function bannedClassUses(text: string) {
  return [...text.matchAll(pattern)].filter((match) => {
    const before = text.slice(
      text.lastIndexOf("\n", match.index) + 1,
      match.index,
    );
    return !(
      /^\s*(?:\/\/|\/?\*|\{\/\*)/.test(before) ||
      /data-testid=["'`]$/.test(before)
    );
  });
}
