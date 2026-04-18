export function shouldEnableInboxForPathname(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];

  return lastSegment === "projects" || lastSegment === "inbox";
}
