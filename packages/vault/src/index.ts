// @blindvault/vault: Domain model: items, fields, templates, folders, versions, tombstones.

export { ContentInvalidError, HlcReadOnlyError, VaultError } from './errors';
export { FUTURE_CLOCK_BOUND_MS, HlcClock, checkHlc, compareHlc } from './hlc';
export {
  FIELD_TYPES,
  type FieldType,
  type RoleDefinition,
  TEMPLATES,
  type Template,
  roleOf,
  template,
} from './templates';
export {
  type Field,
  type Item,
  type ItemReading,
  LABEL_MAX,
  type ReadOnlyRule,
  TAGS_MAX,
  TAG_MAX,
  TITLE_MAX,
  isValidDate,
  isValidSeedPhrase,
  itemToCbor,
  normalizeTags,
  readItem,
} from './item';
export {
  DISPLAY_NAME_MAX,
  type Device,
  FOLDER_NAME_MAX,
  type Folder,
  type Kept,
  deviceToCbor,
  folderToCbor,
  readDevice,
  readFolder,
} from './folder';
export {
  DEFAULT_PREFERENCES,
  LOCAL_CONFIG_FORMAT_VERSION,
  type LocalConfigCleartext,
  type LocalConfigEncrypted,
  PREFERENCE_RANGES,
  type Preferences,
  UnsupportedLocalConfigError,
  preferencesValid,
  readLocalConfig,
  readLocalConfigEncrypted,
} from './local-config';
export { codePointLength } from './text';
