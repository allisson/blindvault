// Storage errors. None carries record content: messages name the rule that failed.

export class StorageError extends Error {
  override name = 'StorageError';
}

/** A write that is not a sealed record or a whole Local Config (D82). Nothing was written. */
export class StorageRejectedError extends StorageError {
  override name = 'StorageRejectedError';
}

/** A database whose schema version this app does not know: never opened, never deleted. */
export class UnsupportedSchemaError extends StorageError {
  override name = 'UnsupportedSchemaError';
  constructor(readonly database: string) {
    super('unsupported database schema version');
  }
}

/** The database was closed, by this app window or because another one changed it. */
export class StorageClosedError extends StorageError {
  override name = 'StorageClosedError';
  constructor() {
    super('database closed');
  }
}
