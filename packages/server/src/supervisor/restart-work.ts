import type { Process } from "./Process.js";

export function processHasActiveWork(process: Process): boolean {
  return (
    process.queuedCompactionBlocksInput ||
    process.state.type === "in-turn" ||
    process.state.type === "waiting-input" ||
    process.isRetainingProviderWork()
  );
}

export function countInterruptibleRestartWorkers(
  processes: Iterable<Process>,
): number {
  let count = 0;
  for (const process of processes) {
    if (processHasActiveWork(process) && !process.canDetachForServerReload())
      count++;
  }
  return count;
}
