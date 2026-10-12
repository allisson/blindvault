// Persistent storage (overview §6, D55, D160): requested when a vault is created, paired or restored
// on the device, and its status and usage shown. A browser without the API reports `null`.

export interface StorageStatus {
  /** Whether the browser keeps this origin's storage under pressure; `null` when unknown. */
  readonly persisted: boolean | null;
  /** Bytes used and available to the origin; `null` when unknown. */
  readonly usage: number | null;
  readonly quota: number | null;
}

function manager(): StorageManager | undefined {
  return (globalThis.navigator as Navigator | undefined)?.storage;
}

/** Asks the browser to keep this origin's storage; `false` when refused or unsupported. */
export async function requestPersistence(storage = manager()): Promise<boolean> {
  if (!storage?.persist) return false;
  try {
    return await storage.persist();
  } catch {
    return false;
  }
}

/** The persistence status and the storage estimate, each `null` when the browser gives none. */
export async function storageStatus(storage = manager()): Promise<StorageStatus> {
  let persisted: boolean | null = null;
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    if (storage?.persisted) persisted = await storage.persisted();
  } catch {
    // unknown
  }
  try {
    const estimate = storage?.estimate ? await storage.estimate() : undefined;
    usage = estimate?.usage ?? null;
    quota = estimate?.quota ?? null;
  } catch {
    // unknown
  }
  return { persisted, usage, quota };
}
