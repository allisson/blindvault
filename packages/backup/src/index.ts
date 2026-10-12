// @blindvault/backup: .bvault format, keyslots, export and restore.

export { type BackupRejection, BackupRejectedError } from './errors';
export {
  BACKUP_FORMAT_VERSION,
  BACKUP_MAGIC,
  type BackupHeader,
  EXPORT_KDF,
  type Keyslots,
  MAX_HEADER_LENGTH,
  type ParsedBackup,
  type PasswordKeyslot,
  type RecoveryKeyslot,
  encodeHeader,
  openBackup,
  parseBackup,
  sealBackup,
} from './format';
