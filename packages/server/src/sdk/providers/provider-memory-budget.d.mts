interface MemoryRoot {
  provider?: string;
  pid?: number;
  processGroupIds?: Iterable<number>;
}

interface ProcessMemory {
  pid: number;
  parent: number;
  group: number;
  started?: number;
  bytes: number;
}

interface HostMemory {
  total: number;
  available: number;
}

export class ProviderMemoryCapacityError extends Error {
  readonly outcome: "capacity_unavailable";
  constructor(message?: string);
}

export function providerHostRequestError(
  response: { error?: string; outcome?: string },
  op: string,
): Error;

export function readCgroupMemory(read?: (file: string) => string): HostMemory;

export class ProviderMemoryBudget {
  constructor(options?: {
    limit?: string;
    readHost?: () => HostMemory | Promise<HostMemory>;
    readProcesses?: () => Promise<ProcessMemory[]>;
  });
  reserve(provider: string, readRoots: () => MemoryRoot[]): Promise<() => void>;
}
