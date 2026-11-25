/**
 * Which local path prefixes the HTTP file doors (media + project-files routes)
 * may read. See docs/tactical/018-file-access-scoping.md.
 */
export interface FileAccessSettings {
  /** All scanned project paths. */
  projects: boolean;
  /** The managed uploads directory. */
  uploads: boolean;
  /** Per-OS temp prefixes. */
  temp: boolean;
  /** The home directory. */
  home: boolean;
  /** Literal absolute prefixes, one per entry (`~` expanded server-side). */
  custom: string[];
}

/** Read-only file-access info from the server (for UI hints + env-pin state). */
export interface FileAccessInfo {
  /** True when ALLOWED_FILE_PATHS/ALLOWED_IMAGE_PATHS pins the set (UI read-only). */
  envPinned: boolean;
  /** The env-pinned prefixes (only meaningful when envPinned). */
  envPaths: string[];
  /** Resolved temp prefixes the "Temp folders" toggle expands to. */
  tempPaths: string[];
  /** Managed uploads directory. */
  uploadsDir: string;
  /** Home directory. */
  homeDir: string;
}

/** Default file-access settings (secure-by-default; mirrors the server). */
export const DEFAULT_FILE_ACCESS: FileAccessSettings = {
  projects: true,
  uploads: true,
  temp: true,
  home: false,
  custom: [],
};
