// @blindvault/storage: IndexedDB schema and encrypted record persistence. It accepts only sealed
// records and Local Config (D82), and never parses either.

export { type CleanupReport, type LocalConfigReader, cleanupDatabases } from './cleanup';
export {
  DATABASE_PREFIX,
  type Migration,
  MIGRATIONS,
  SCHEMA_VERSION,
  type StorageCommit,
  type StorageKey,
  VaultDatabase,
  databaseName,
  isDatabaseName,
} from './database';
export {
  StorageClosedError,
  StorageError,
  StorageRejectedError,
  UnsupportedSchemaError,
} from './errors';
export {
  type HeldLock,
  INSTALLATION_GUARD,
  acquireInstallationGuard,
  acquireVaultLock,
} from './locks';
export { type StorageStatus, requestPersistence, storageStatus } from './persistence';
