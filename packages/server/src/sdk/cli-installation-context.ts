import type { CliInstallationService } from "../services/CliInstallationService.js";

// One installation owner per server process; workers receive their own snapshot.
let service: CliInstallationService | undefined;
export function setCliInstallationService(
  value: CliInstallationService | undefined,
): void {
  service = value;
}
export function getCliInstallationService():
  | CliInstallationService
  | undefined {
  return service;
}
