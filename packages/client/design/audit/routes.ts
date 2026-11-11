export const AUDIT_PAGE = {
  id: "audit",
  title: "Design audit",
  file: "design/audit/AuditPage.tsx",
  href: "design.html#/audit",
} as const;

export const AUDIT_SECTIONS = [
  "migrations",
  "exceptions",
  "generated",
] as const;
export type AuditSection = (typeof AUDIT_SECTIONS)[number];

/** Existing bookmarks open the corresponding section of the single report. */
export function legacyAuditSection(target: string): AuditSection | undefined {
  const pages: Record<string, AuditSection> = {
    "census-composer": "migrations",
    "census-control-overrides": "exceptions",
    "census-button-base-exceptions": "exceptions",
    "census-element-exceptions": "exceptions",
    "census-token-literals": "exceptions",
    "census-runtime-class-families": "generated",
  };
  const page = target.replace(/--remaining$/, "");
  return Object.hasOwn(pages, page) ? pages[page] : undefined;
}
