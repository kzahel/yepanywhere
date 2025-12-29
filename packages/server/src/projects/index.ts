/**
 * Project management utilities
 *
 * This module provides tools for working with Claude's project and session
 * storage in ~/.claude/projects/.
 *
 * Key exports:
 * - Path encoding/decoding utilities (see paths.ts for detailed docs)
 * - ProjectScanner for discovering projects
 */

// Path utilities - see paths.ts for comprehensive documentation on encoding schemes
export {
  CLAUDE_DIR,
  CLAUDE_PROJECTS_DIR,
  decodeProjectId,
  encodeProjectId,
  getFileTypeFromRelativePath,
  getProjectName,
  getSessionFilePath,
  getSessionIdFromPath,
  readCwdFromSessionFile,
} from "./paths.js";

// Project scanning
export { ProjectScanner, projectScanner } from "./scanner.js";
export type { ScannerOptions } from "./scanner.js";
