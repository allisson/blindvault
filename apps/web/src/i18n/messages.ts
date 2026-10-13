// UI copy in `en` and `pt-BR` (D165). `pt-BR` has exactly the shape of `en`, checked by the type and
// by `messages.test.ts`. Template and role names are keyed by `templateId` and `templateId.role`,
// since one role name can mean different things in two templates (`identity.address`,
// `crypto-wallet.address`).

const en = {
  app: {
    name: 'BlindVault',
    locked: 'Locked',
    unlocked: 'Unlocked',
    lock: 'Lock',
    settings: 'Settings',
    back: 'Back',
    retry: 'Try again',
    reload: 'Reload',
  },
  about: {
    open: 'About',
    title: 'About BlindVault',
    version: 'Version',
    hash: 'SHA-256 of the asset manifest',
    unavailable: 'Not available in this build.',
    informational:
      'The app shows these values about itself, and a modified app can show any value. They do not prove which code runs.',
    verify:
      'Verify a release outside the app: compare this hash with the one published in the release, then check the served files against its manifest with',
    releases: 'Releases on GitHub',
  },
  update: {
    available: 'An update is available: version {current} → {next}.',
    hash: 'SHA-256 of its asset manifest:',
    verify: 'Compare this hash with the one published in the release before you update.',
    note: 'Updating locks the vault and reloads the app.',
    apply: 'Update and lock',
  },
  changedWorker: {
    title: 'Changed service worker',
    found:
      'The host served a changed service worker, which can replace this app. The vault was locked.',
    notes:
      'A release that changes the service worker must say so and why in its release notes. Do not unlock the vault until you have verified the release outside the app: compare the served files with its published asset manifest, or rebuild it from source.',
    continue: 'I verified, continue',
  },
  preview: {
    banner:
      'Preview build: vaults and backups made here may not open in a later version, and no migration is planned for them. Do not keep anything here you cannot lose.',
  },
  origin: {
    shared:
      'This copy of BlindVault runs under a sub-path of a github.io address, which other sites share: they can read and delete its storage. Do not keep anything here; use a copy served from its own address.',
  },
  framed: {
    title: 'Open in its own tab',
    body: 'BlindVault does not open inside another page, which could hide or imitate parts of it.',
    open: 'Open BlindVault in its own tab',
  },
  start: {
    starting: 'Opening…',
    incomplete: 'Part of the app failed to load, so the vault stays closed. Reload to try again.',
    busy: 'BlindVault is busy in another window. Finish there, then try again.',
    elsewhere: 'BlindVault is open in another window.',
    takeOver: 'Use here',
    takeOverNote: 'This locks the vault in the other window.',
    updateRequired:
      'This vault was written by a newer version of BlindVault. Update the app to open it.',
    corrupt: 'The local configuration of this vault cannot be read.',
    unsupported: 'This browser lacks IndexedDB or Web Locks, which BlindVault needs.',
    chooseIntro:
      'BlindVault has no server: your vault lives only on your devices and in your backups.',
    create: 'Create a new vault',
    restore: 'Restore from a backup',
  },
  restore: {
    title: 'Restore from a backup',
    intro:
      'Choose a .bvault file. It opens with its Recovery Phrase, or with its export password if it has one.',
    file: 'Backup file',
    notBackup: 'This file is not a BlindVault backup.',
    newerVersion:
      'This backup was made by a newer version of BlindVault. Update the app to restore it.',
    malformed: 'This backup is damaged: its header cannot be read.',
    header:
      'Its Recovery Phrase, {id}, was created on {date}. Not verified until the backup opens.',
    method: 'Open with',
    byPhrase: 'Recovery Phrase',
    byPassword: 'Export password',
    phrase: 'Your 24 words',
    password: 'Export password',
    open: 'Open the backup',
    opening: 'Opening the backup…',
    wrongPhrase: 'The backup did not open with this Recovery Phrase.',
    wrongPassword: 'The backup did not open with this export password.',
    noPasswordKeyslot: 'This backup has no export password: use its Recovery Phrase.',
    corrupt: 'This backup is damaged or incomplete. It cannot be restored.',
    corruptRecord:
      'This backup holds a record that does not verify: {type} {id}. It cannot be restored.',
    corruptUnnamed: 'This backup holds a record that cannot be read. It cannot be restored.',
    inconsistent: 'This backup does not match its own Recovery Phrase. It cannot be restored.',
    opened: 'Backup made on {date}, verified.',
    passwordIntro:
      'Choose the local password for this device. It is neither the export password nor stored in the backup.',
    local: 'Local password',
    confirm: 'Repeat the password',
    submit: 'Restore',
    restoring: 'Restoring the vault…',
    locked: 'The restore stopped before anything was saved. Open the file again.',
    cancel: 'Cancel',
    checkPhrase:
      'This vault was restored with an export password. In Settings, check that your Recovery Phrase still opens it.',
    dismiss: 'Dismiss',
    readmit:
      'This device was restored from a backup and is not registered: until another device of the vault re-admits it, it exchanges data with them only through backups. Settings lists those devices.',
    openSettings: 'Open Settings',
  },
  reset: {
    forgot: 'Forgot the password?',
    title: 'Reset the local password',
    intro:
      'Your Recovery Phrase sets a new local password on this device, keeping everything the vault holds here.',
    hint: 'Use the phrase this device knows: if it was regenerated on another device and this one has not synced since, it is the old one.',
    next: 'Next',
    passwordIntro: 'Now choose the new local password for this device.',
    submit: 'Reset the password',
    working: 'Resetting the password…',
    wrongPhrase: "This phrase does not open this vault's Recovery Envelope.",
    masterKey:
      'This phrase opens the Recovery Envelope held here, but not this vault: the storage is damaged, or someone holding the Master Key changed it. Replace the vault with a backup.',
    noEnvelope: 'This vault has no Recovery Envelope to open. Replace it with a backup.',
    locked: 'The reset stopped before anything was saved. Try again.',
  },
  replace: {
    choose: 'Replace with a backup…',
    title: 'Replace this vault with a backup',
    warning:
      'The vault on this device is deleted and replaced by the backup, whether it is of this vault or of another one. Changes that exist only on this device are lost. If you can still unlock the vault, make a backup first, in Settings.',
    retire:
      "Afterwards, retire this device's Device record from another device of the replaced vault: until then they keep offering it as a sync peer. Its name cannot be shown while the vault is locked.",
    understand: 'I understand that the vault on this device will be replaced',
    submit: 'Replace',
    replacing: 'Replacing the vault…',
    leftoverPasskey:
      'The passkey of the replaced vault no longer unlocks anything: delete the "BlindVault" passkey you no longer use in your passkey manager.',
  },
  merge: {
    title: 'Merge a backup',
    intro:
      'Brings the records of a backup of this vault into it, as a sync would: the newer copy of each record wins, and the older version of an item goes to its history. A merge cannot be undone.',
    choose: 'Merge a backup…',
    confirm: 'Backup made on {date}, verified. Merge it into this vault?',
    submit: 'Merge',
    merging: 'Merging…',
    done: 'Merged: {added} added, {replaced} replaced.',
    differentVault:
      'This backup is of another vault. It cannot be merged into this one. To replace this vault with it, lock and choose Replace with a backup.',
    masterKey: 'This backup has the ID of this vault but another Master Key. It cannot be merged.',
    corruptRecord:
      'This backup holds a record that does not verify: {type} {id}. It cannot be merged.',
    immutable:
      'This backup holds a changed copy of a record that never changes: {type} {id}. It cannot be merged: only someone holding the Master Key, or a bug, makes one.',
    futureClock:
      "This backup holds records dated ahead of this device's clock. It can be merged from {date}.",
    locked: 'The merge stopped before anything was saved. Open the file again.',
    phraseChanged:
      'The Recovery Phrase was regenerated on another device: the new one, {id}, was created on {date}. New backups open only with it: check yours with Check Recovery Phrase below.',
    phraseSuperseded:
      'The Recovery Phrase you wrote down for this device, {id}, created on {date}, was replaced by one regenerated on another device. Backups made with it open only with it, so keep it until you have a new backup. New backups open only with the new phrase.',
    backupNow: 'Make a backup now',
    newDevices:
      'Devices this device had never seen: {names}. A device you did not pair means someone holding the Master Key added it.',
    alreadyRetired: '{name} (already retired)',
    retiredDevices:
      'Devices now retired: {names}. If you did not retire them, someone holding the Master Key did.',
    droppedLosers:
      'An older edit made on this device no longer fits the history of: {titles}. It was dropped.',
    ownRetired:
      'This device was retired from the vault. To sync again, replace it by pairing with another device. If you did not retire it, someone holding the Master Key did: re-found the vault.',
  },
  create: {
    title: 'Create a vault',
    intro:
      'BlindVault has no server: nobody can reset your vault for you. Your data stays on your devices.',
    password: 'Local password',
    confirm: 'Repeat the password',
    submit: 'Create vault',
    working: 'Creating the vault…',
    mismatch: 'The passwords do not match.',
    weak: 'This password is too easy to guess. Use a longer passphrase.',
    strong: 'Strong enough.',
    browserSave:
      'Do not let the browser save this password: depending on the browser, a copy of its data could then be enough to open the vault.',
    phraseTitle: 'Your Recovery Phrase',
    phraseIntro:
      'These 24 words, with a backup, recover the vault if you forget the local password or lose this device. BlindVault has no server, so nobody else can recover it for you. Write them on paper, in order, and keep them somewhere safe.',
    phraseOnce:
      'They are shown only now: BlindVault does not keep them and cannot show them again.',
    phraseNoPhoto:
      'Do not take a screenshot or a photo: it lands in the gallery and in its cloud backup.',
    phraseWritten: 'I wrote them down',
    word: 'Word {n}',
    confirmTitle: 'Confirm the Recovery Phrase',
    confirmIntro: 'From what you wrote down, type the words at these positions.',
    confirmSubmit: 'Confirm',
    confirmWrong:
      'Those words do not match. Check what you wrote down against the phrase, then confirm again.',
    passwordIntro: 'Last, set the local password that unlocks the vault on this device.',
  },
  unlock: {
    title: 'Unlock the vault',
    password: 'Local password',
    submit: 'Unlock',
    working: 'Unlocking…',
    wrong: 'Wrong password.',
    passkey: 'Unlock with passkey',
    passkeyCancelled: 'The passkey prompt was closed. Try again, or use the password.',
    passkeyRejected: 'This passkey does not unlock this vault. Use the password.',
    passkeyNoVerification:
      'The authenticator did not verify you with a PIN, fingerprint or face, so the passkey cannot unlock. Use the password.',
    passkeyUnavailable:
      'The authenticator did not give what BlindVault needs to unlock. Use the password.',
  },
  vault: {
    folders: 'Folders',
    allItems: 'All items',
    items: 'Items',
    detail: 'Details',
    empty: 'No items yet.',
    nothingSelected: 'Select an item.',
    trash: 'Trash',
    trashEmpty: 'The trash is empty.',
    search: 'Search',
    searchHint: 'Searches titles, tags, folders, notes and fields that are not secret.',
    results: 'Results',
    noResults: 'No items match.',
    readOnlyVault:
      "The vault is read-only: a record is dated ahead of this device's clock. Check the clock.",
    reminderNever:
      'No backup has been made on this device: make one, so you can restore the vault if you lose this device.',
    reminderStale:
      'The last backup made on this device is from {date}, more than 30 days ago: make a new one.',
    reminderOldPhrase:
      'No backup made on this device opens with the current Recovery Phrase: make a new one.',
    reminderBackup: 'Make a backup',
  },
  items: {
    new: 'New item',
    chooseTemplate: 'Choose a template',
    title: 'Title',
    tags: 'Tags',
    tagsHint: 'Separate tags with commas.',
    notes: 'Notes',
    addField: 'Add a field',
    fieldLabel: 'Label',
    fieldType: 'Field type',
    add: 'Add',
    remove: 'Remove',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    edit: 'Edit',
    moveToTrash: 'Move to trash',
    restore: 'Restore',
    show: 'Show',
    hide: 'Hide',
    open: 'Open',
    newerTitle: 'Item from a newer version',
    readOnlyNewer:
      'This item was saved by a newer version of BlindVault. Update the app to edit or duplicate it.',
    readOnlyClock:
      "This item is dated ahead of this device's clock. It can be changed once the clock reaches that date.",
    inTrash: 'In the trash. It can only be restored; it is deleted for good on {date}.',
    multiLine: 'Show the value to enter several lines.',
    checksum: 'The checksum of this seed phrase does not match. Check the words.',
    duplicate: 'Duplicate',
    copySuffix: ' (copy)',
    copyTitleTooLong:
      "The copy's title would be longer than 512 characters. Shorten the title first.",
    history: 'History',
    historyTitle: 'History of {title}',
    historyNote:
      'Earlier values stay in this history, on every device and in later backups, in up to 20 versions. To remove them, duplicate the item and move the original to the trash: its history is deleted when it is purged from the trash.',
    noHistory: 'No earlier versions.',
    backToItem: 'Back to the item',
    restoreVersion: 'Restore this version',
    versionNewer: 'Saved by a newer version of BlindVault: it cannot be restored here.',
    versionClock:
      "Dated ahead of this device's clock: it can be restored once the clock reaches that date.",
    copy: 'Copy',
    copyCode: 'Copy code',
    copied:
      'Copied. BlindVault tries to clear the clipboard in {seconds} s while it has focus; clearing is not guaranteed.',
    copyFailed: 'The browser did not allow copying.',
    totpCode: 'Current code',
    totpSecret: 'TOTP secret',
    totpExpires: 'Changes in {seconds} s',
    totpHint: 'Paste an otpauth:// link or the TOTP secret.',
    totpKeep: 'Leave empty to keep the current TOTP secret, or paste a new link or secret.',
    monthFormat: 'YYYY-MM',
    invalid: 'Fix the fields marked above.',
    tooLarge: 'This item is too large to save.',
    blocked: 'This item cannot be changed now.',
  },
  folders: {
    new: 'New folder',
    newSubfolder: 'New subfolder',
    name: 'Folder name',
    create: 'Create',
    rename: 'Rename',
    move: 'Move',
    moveTo: 'Move to',
    root: 'No folder (vault root)',
    folder: 'Folder',
    empty: 'This folder is empty.',
    trashNote: 'Moving a folder to the trash also moves its subfolders and their items.',
    restoreNote: 'Restoring a folder brings back what was trashed with it.',
    blocked: 'Nothing was changed: these records are read-only.',
    'newer-content': 'saved by a newer version of BlindVault',
    'future-clock': "dated ahead of this device's clock",
    nameRequired: 'Enter a folder name.',
    nameTooLong: 'The name is longer than 256 characters.',
    nameSingleLine: 'The name takes a single line.',
    cycle: 'A folder cannot move into itself or one of its subfolders.',
    failed: 'This folder cannot be changed now.',
  },
  errors: {
    titleRequired: 'Enter a title.',
    titleTooLong: 'The title is longer than 512 characters.',
    tagsTooMany: 'An item holds at most 32 tags.',
    tagTooLong: 'A tag is longer than 64 characters.',
    'single-line': 'This field takes a single line.',
    date: 'Enter a valid date.',
    month: 'Enter a month as YYYY-MM.',
    number: 'Enter a number, such as 42 or 3.5.',
    'seed-phrase': 'Use 12, 15, 18, 21 or 24 words of the BIP39 English list.',
    totp: 'Paste an otpauth://totp/ link, or a TOTP secret of letters A–Z and digits 2–7.',
    'label-required': 'Enter a label for this field.',
    'label-too-long': 'The label is longer than 128 characters.',
  },
  fieldTypes: {
    text: 'Text',
    'long-text': 'Long text',
    secret: 'Secret',
    url: 'URL',
    email: 'Email',
    phone: 'Phone',
    date: 'Date',
    number: 'Number',
    totp: 'TOTP',
    'seed-phrase': 'Seed phrase',
  },
  generator: {
    generate: 'Generate',
    characters: 'Characters',
    words: 'Words',
    length: 'Length (12–128)',
    wordCount: 'Words (4–24)',
    lowercase: 'a–z',
    uppercase: 'A–Z',
    digits: '0–9',
    symbols: 'Symbols',
    entropy: '{bits} bits of entropy',
    unavailable: 'Choose at least 12 characters or 4 words, and one character set.',
    use: 'Use this password',
  },
  settings: {
    title: 'Settings',
    password: 'Change the local password',
    current: 'Current password',
    next: 'New password',
    confirm: 'Repeat the new password',
    change: 'Change password',
    changing: 'Changing the password…',
    changed: 'Password changed.',
    wrong: 'The current password is wrong.',
    locking: 'Locking',
    autoLock: 'Lock after inactivity (minutes, 1–60)',
    hiddenLock: 'Lock after the app is hidden (seconds, 0–900)',
    hiddenImmediate:
      'At 0 the vault locks as soon as the app is hidden, including during a file picker or passkey prompt on some systems.',
    clipboard: 'Clear the clipboard after (seconds, 10–120)',
    save: 'Save',
    saved: 'Saved.',
    outOfRange: 'A value is outside its range.',
    language: 'Language',
    passkey: 'Passkey unlock',
    passkeyIntro:
      'Unlock on this device with a passkey instead of typing the local password. The password keeps working.',
    passkeyLostDevice:
      "With a passkey, whoever holds this device needs only its screen lock, fingerprint or face, or the security key's PIN, not the local password. Use a strong device PIN.",
    passkeyPassword: 'Local password',
    passkeySetUp: 'Set up passkey',
    passkeySettingUp: 'Setting up the passkey…',
    passkeyOn: 'Passkey unlock is set up on this device.',
    passkeyDone: 'Passkey set up.',
    passkeySynced:
      "This passkey is synced by a platform account, such as iCloud Keychain or Google Password Manager. Whoever controls that account and gets a copy of this device's storage can unlock the vault without this device: the vault now also depends on the security of that account.",
    passkeyRemove: 'Remove passkey',
    passkeyRemoved: 'Passkey removed. Your passkey manager was asked to delete it.',
    passkeyRemovedByHand:
      'Passkey removed. It no longer unlocks anything: delete the "BlindVault" passkey in your passkey manager.',
    passkeyCancelled: 'The passkey prompt was closed, or the vault locked. Nothing was set up.',
    passkeyNoVerification:
      'The authenticator did not verify you, so nothing was set up. Use a passkey that asks for a PIN, fingerprint or face.',
    passkeyUnavailable:
      'This passkey cannot unlock BlindVault: its authenticator lacks the PRF extension. Nothing was set up.',
    passkeyUnsupported: 'This browser does not support passkey unlock.',
    recovery: 'Recovery Phrase',
    recoveryCreated: 'The current Recovery Phrase was created on {date} ({id}).',
    recoveryNoBackup:
      'No backup made on this device opens with the current Recovery Phrase yet: make one in Backup, above.',
    regenTitle: 'Regenerate the Recovery Phrase',
    regenIntro:
      'If you lost the Recovery Phrase, regenerate it while the vault is unlocked: a new phrase replaces it, and nothing in the vault changes.',
    regenExposed:
      'Regenerating does not help if someone else saw or copied the phrase: it still opens every backup made with it, and the Recovery Envelope of any device that has not synced since, and so yields the Master Key. An exposed phrase means the vault must be re-founded.',
    regenBackups:
      'Backups made until now open only with the current phrase. Your other devices keep it, and keep making backups for it, until they sync with this one.',
    regenStart: 'Regenerate the Recovery Phrase…',
    regenContinue: 'Show the new phrase',
    regenCancel: 'Cancel',
    regenPhraseTitle: 'Your new Recovery Phrase',
    regenAuthIntro:
      'The new phrase recovers the Master Key, so regenerating asks for your local password again.',
    regenAuth: 'Local password',
    regenSubmit: 'Regenerate',
    regenWorking: 'Regenerating…',
    regenPasskey: 'Regenerate with the passkey instead',
    regenWrong: 'Wrong password. The Recovery Phrase did not change.',
    regenPasskeyCancelled: 'The passkey prompt was closed. The Recovery Phrase did not change.',
    regenPasskeyFailed: 'The passkey did not open the vault. Use the password.',
    regenDone: 'The Recovery Phrase was regenerated: {id}, created on {date}.',
    regenOtherDevices:
      'The new phrase is not on your other devices yet: they receive it when they sync with this one, and until then their backups open only with the previous phrase.',
    regenOldBackups:
      'Backups made before now open only with the previous phrase. Make a new backup now.',
    regenBackupNow: 'Make a backup now',
    regenNewer:
      'The Recovery Envelope was written by a newer version of BlindVault. Update the app to regenerate the Recovery Phrase.',
    regenFutureClock:
      "The Recovery Envelope is dated ahead of this device's clock. The Recovery Phrase can be regenerated from {date}.",
    regenReadOnly:
      "This device's clock went back, so the vault is read-only. The Recovery Phrase can be regenerated from {date}.",
    recoveryIntro:
      'Type the 24 words you wrote down to confirm that they open this vault and its backups. Nothing you type is stored.',
    recoveryInput: 'Your 24 words',
    recoveryCheck: 'Check Recovery Phrase',
    recoveryOpens: 'This phrase opens this vault and its backups.',
    recoveryWrong: "This is not this vault's current Recovery Phrase.",
    recoveryPublicKey:
      'This phrase opens the vault, but backups cannot be opened with it. Regenerate the Recovery Phrase, then make a new backup.',
    recoveryMasterKey:
      'This phrase opens a Recovery Envelope that does not recover this vault, so backups cannot be restored with it. Regenerate the Recovery Phrase, then make a new backup.',
    recoveryWordCount: 'A Recovery Phrase has 24 words.',
    recoveryUnknownWord: 'Word {n} is not a Recovery Phrase word.',
    recoveryChecksum:
      'These words are not a valid Recovery Phrase. Check each one against what you wrote down.',
    recoveryNone:
      'This vault has no Recovery Phrase: the preview build created it, and it cannot be recovered. Create a new vault to get one.',
    recoveryCorrupt:
      'The Recovery Envelope on this device is damaged, so the Recovery Phrase cannot be checked. Regenerate the Recovery Phrase to replace it.',
    backup: 'Backup',
    backupIntro:
      'A backup is an encrypted file with a full copy of this vault. Your Recovery Phrase always opens it. Keep copies away from this device, so you can restore if you lose it.',
    backupLast: 'Last backup made on this device: {date}.',
    backupNever: 'No backup has been made on this device yet.',
    backupIncomplete:
      'Some records from other devices were rejected because they need a newer app version, so this backup may be incomplete. Update the app and sync with them first.',
    backupNone:
      'This vault has no Recovery Phrase: the preview build created it, so no backup of it could be opened. Create a new vault to get one.',
    backupProtect: 'Also protect it with an export password',
    backupMasterKey:
      "Whoever opens this backup with its export password holds the vault's Master Key for good. If the export password and a copy of the backup are ever exposed together, the vault must be re-founded.",
    exportPassword: 'Export password',
    exportConfirm: 'Repeat the export password',
    exportGenerate: 'Generate a passphrase',
    exportGenerated:
      'Write this passphrase down: it opens the backup without the Recovery Phrase, and BlindVault does not keep it.',
    exportWeak:
      'Too easy to guess for a file that can be attacked offline. Use a longer password, or generate a passphrase.',
    exportStrong: 'Strong enough for a backup.',
    backupAuth: 'Local password',
    backupAuthIntro:
      "A backup holds the vault's Master Key, so exporting asks for your local password again.",
    backupExport: 'Export',
    backupExporting: 'Exporting…',
    backupPasskey: 'Export with the passkey instead',
    backupDone:
      'Backup exported as {name}. It opens with the Recovery Phrase {id}, created on {date}. Keep it somewhere other than this device.',
    backupWrong: 'Wrong password. No backup was made.',
    backupCorrupt:
      'A record failed verification, so no backup was made: {type} {id}. Nothing on this device was changed.',
    backupPasskeyCancelled: 'The passkey prompt was closed. No backup was made.',
    backupPasskeyRejected: 'This passkey does not open this vault. Use the password.',
    backupPasskeyNoVerification:
      'The authenticator did not verify you with a PIN, fingerprint or face. Use the password.',
    backupPasskeyUnavailable:
      'The authenticator did not give what BlindVault needs. Use the password.',
    backupHidden:
      'The vault locks as soon as the app is hidden: if the browser hides it while it saves the file, the vault locks, and the export must be repeated.',
    devices: 'Devices',
    devicesThis: '{name} (this device)',
    devicesRegistered: 'Registered on {date}',
    devicesRetiredCount: 'Retired devices, not shown: {n}.',
    devicesReadmit:
      'This device is not registered: it was restored from a backup, and the other devices do not know it. Until one of the devices below re-admits it, it exchanges data with them only through backups.',
    devicesOnly:
      'This is the only device of this vault. If this browser loses its storage, only a backup and the Recovery Phrase bring the vault back: make a backup, and pair another device.',
    devicesRetire: 'Retire',
    devicesRetireWarning:
      'Retire {name}? Retirement cannot be undone. It is not revocation: whatever that device already holds stays readable to whoever has it. If it may be in someone else’s hands, re-found the vault.',
    devicesRetireConfirm: 'Retire {name}',
    devicesRetireCancel: 'Cancel',
    devicesRetired: '{name} is retired.',
    devicesRefused: 'That device cannot be retired: it is this device, or it is already retired.',
    recordTypes: {
      item: 'Item',
      folder: 'Folder',
      itemVersion: 'Item Version',
      vaultKey: 'Vault Key',
      recoveryEnvelope: 'Recovery Envelope',
      device: 'Device record',
    },
  },
  refound: {
    title: 'Re-found the vault',
    intro:
      'If someone else may hold the Master Key (an exposed Recovery Phrase or export password, a retirement you did not make, a device you did not pair), re-found the vault: what this device holds moves to a new vault under entirely new keys.',
    start: 'Re-found the vault…',
    warnSync:
      'Sync this device first with every other device still in your hands: changes that are not on this device are lost. Afterwards, pair each other device again with the new vault, and destroy the backups of the old vault: they still open it with the old Recovery Phrase.',
    warnRetired:
      'This device was retired, so it cannot sync first: changes that exist only on other devices are lost. If a device that was not retired is still in your hands, re-found there instead.',
    warnTrash:
      'The trash and the history of every item are emptied. Restore from the trash anything you still need first.',
    openTrash: 'Open the trash',
    warnCorrupt: 'Records this device cannot read, which are not carried over: {n}.',
    warnCopied:
      'Re-founding protects only what happens afterwards: whoever already copied the old vault keeps it.',
    warnRejected:
      'This device rejected records from {names}, made by a newer app version. They are not on this device and will be lost: update the app and sync with those devices first.',
    understand:
      'I understand that changes not on this device, the trash and the history are lost, and that the other devices and the old backups stay with the old vault.',
    understandRejected: 'I understand that the records from {names} are lost.',
    continue: 'Continue',
    authIntro: 'Confirm it is you with the local password of this vault, or with its passkey.',
    auth: 'Local password',
    authSubmit: 'Confirm',
    authPasskey: 'Use the passkey',
    wrong: 'Wrong password.',
    passkeyCancelled: 'The passkey prompt was closed.',
    passkeyFailed: 'The passkey did not open the vault. Use the password.',
    phraseTitle: 'The Recovery Phrase of the new vault',
    passwordIntro: 'Choose the local password of the new vault on this device.',
    password: 'New local password',
    confirmPassword: 'Repeat the new local password',
    submit: 'Re-found',
    working: 'Re-founding the vault…',
    busy: 'BlindVault is busy in another window. Try again once it is done.',
    cancel: 'Cancel',
    done: 'The vault was re-founded. Make a backup of the new vault now, pair your other devices with it again, and destroy the backups of the old vault. A passkey can be set up again in Settings.',
  },
  templates: {
    login: 'Login',
    'secure-note': 'Secure note',
    card: 'Payment card',
    identity: 'Identity',
    'developer-credential': 'Developer credential',
    'crypto-wallet': 'Crypto wallet',
    document: 'Document',
  },
  roles: {
    'login.username': 'Username',
    'login.password': 'Password',
    'login.url': 'Website',
    'card.cardholder': 'Cardholder',
    'card.number': 'Card number',
    'card.expiry': 'Expiry',
    'card.cvv': 'Security code',
    'card.pin': 'PIN',
    'identity.firstName': 'First name',
    'identity.lastName': 'Last name',
    'identity.birthDate': 'Date of birth',
    'identity.email': 'Email',
    'identity.phone': 'Phone',
    'identity.address': 'Address',
    'developer-credential.provider': 'Provider',
    'developer-credential.baseUrl': 'Base URL',
    'developer-credential.keyId': 'Key ID',
    'developer-credential.secret': 'Secret',
    'crypto-wallet.walletName': 'Wallet name',
    'crypto-wallet.network': 'Network',
    'crypto-wallet.seedPhrase': 'Seed phrase',
    'crypto-wallet.passphrase': 'Passphrase',
    'crypto-wallet.derivationPath': 'Derivation path',
    'crypto-wallet.address': 'Wallet address',
    'document.documentType': 'Document type',
    'document.number': 'Document number',
    'document.fullName': 'Full name',
    'document.issuer': 'Issuer',
    'document.issueDate': 'Issue date',
    'document.expiryDate': 'Expiry date',
  },
};

export type Messages = typeof en;

const ptBR: Messages = {
  app: {
    name: 'BlindVault',
    locked: 'Bloqueado',
    unlocked: 'Desbloqueado',
    lock: 'Bloquear',
    settings: 'Configurações',
    back: 'Voltar',
    retry: 'Tentar de novo',
    reload: 'Recarregar',
  },
  about: {
    open: 'Sobre',
    title: 'Sobre o BlindVault',
    version: 'Versão',
    hash: 'SHA-256 do manifesto de assets',
    unavailable: 'Indisponível neste build.',
    informational:
      'O app mostra esses valores sobre si mesmo, e um app alterado pode mostrar qualquer valor. Eles não provam qual código está rodando.',
    verify:
      'Verifique uma versão fora do app: compare este hash com o publicado na versão e confira os arquivos servidos contra o manifesto dela com',
    releases: 'Versões no GitHub',
  },
  update: {
    available: 'Há uma atualização disponível: versão {current} → {next}.',
    hash: 'SHA-256 do manifesto de assets:',
    verify: 'Compare este hash com o publicado na versão antes de atualizar.',
    note: 'Atualizar bloqueia o cofre e recarrega o app.',
    apply: 'Atualizar e bloquear',
  },
  changedWorker: {
    title: 'Service worker alterado',
    found:
      'O host serviu um service worker alterado, que pode substituir este app. O cofre foi bloqueado.',
    notes:
      'Uma versão que altera o service worker precisa dizer isso, e por quê, nas notas da versão. Não desbloqueie o cofre antes de verificar a versão fora do app: compare os arquivos servidos com o manifesto de assets publicado, ou recompile a partir do código-fonte.',
    continue: 'Verifiquei, continuar',
  },
  preview: {
    banner:
      'Versão de prévia: cofres e backups feitos aqui podem não abrir numa versão futura, e não há migração prevista para eles. Não guarde aqui nada que você não possa perder.',
  },
  origin: {
    shared:
      'Esta cópia do BlindVault roda num subcaminho de um endereço github.io, que outros sites compartilham: eles podem ler e apagar os dados dela. Não guarde nada aqui; use uma cópia servida no próprio endereço.',
  },
  framed: {
    title: 'Abra numa aba própria',
    body: 'O BlindVault não abre dentro de outra página, que poderia esconder ou imitar partes dele.',
    open: 'Abrir o BlindVault numa aba própria',
  },
  start: {
    starting: 'Abrindo…',
    incomplete:
      'Parte do app não carregou, então o cofre continua fechado. Recarregue para tentar de novo.',
    busy: 'O BlindVault está ocupado em outra janela. Termine lá e tente de novo.',
    elsewhere: 'O BlindVault está aberto em outra janela.',
    takeOver: 'Usar aqui',
    takeOverNote: 'Isso bloqueia o cofre na outra janela.',
    updateRequired:
      'Este cofre foi gravado por uma versão mais nova do BlindVault. Atualize o app para abri-lo.',
    corrupt: 'A configuração local deste cofre não pode ser lida.',
    unsupported: 'Este navegador não tem IndexedDB ou Web Locks, de que o BlindVault precisa.',
    chooseIntro:
      'O BlindVault não tem servidor: seu cofre existe só nos seus dispositivos e nos seus backups.',
    create: 'Criar um cofre novo',
    restore: 'Restaurar de um backup',
  },
  restore: {
    title: 'Restaurar de um backup',
    intro:
      'Escolha um arquivo .bvault. Ele abre com a Frase de Recuperação, ou com a senha de exportação, se tiver uma.',
    file: 'Arquivo de backup',
    notBackup: 'Este arquivo não é um backup do BlindVault.',
    newerVersion:
      'Este backup foi feito por uma versão mais nova do BlindVault. Atualize o app para restaurá-lo.',
    malformed: 'Este backup está danificado: o cabeçalho não pode ser lido.',
    header:
      'A Frase de Recuperação dele, {id}, foi criada em {date}. Não verificado até o backup abrir.',
    method: 'Abrir com',
    byPhrase: 'Frase de Recuperação',
    byPassword: 'Senha de exportação',
    phrase: 'Suas 24 palavras',
    password: 'Senha de exportação',
    open: 'Abrir o backup',
    opening: 'Abrindo o backup…',
    wrongPhrase: 'O backup não abriu com esta Frase de Recuperação.',
    wrongPassword: 'O backup não abriu com esta senha de exportação.',
    noPasswordKeyslot: 'Este backup não tem senha de exportação: use a Frase de Recuperação.',
    corrupt: 'Este backup está danificado ou incompleto. Ele não pode ser restaurado.',
    corruptRecord:
      'Este backup contém um registro que não verifica: {type} {id}. Ele não pode ser restaurado.',
    corruptUnnamed: 'Este backup contém um registro ilegível. Ele não pode ser restaurado.',
    inconsistent:
      'Este backup não confere com a própria Frase de Recuperação. Ele não pode ser restaurado.',
    opened: 'Backup feito em {date}, verificado.',
    passwordIntro:
      'Escolha a senha local deste dispositivo. Ela não é a senha de exportação e não fica no backup.',
    local: 'Senha local',
    confirm: 'Repita a senha',
    submit: 'Restaurar',
    restoring: 'Restaurando o cofre…',
    locked: 'A restauração parou antes de salvar qualquer coisa. Abra o arquivo de novo.',
    cancel: 'Cancelar',
    checkPhrase:
      'Este cofre foi restaurado com uma senha de exportação. Em Configurações, confira se a sua Frase de Recuperação ainda o abre.',
    dismiss: 'Dispensar',
    readmit:
      'Este dispositivo foi restaurado de um backup e não está registrado: até que outro dispositivo do cofre o readmita, ele troca dados com eles só por backups. Configurações lista esses dispositivos.',
    openSettings: 'Abrir Configurações',
  },
  reset: {
    forgot: 'Esqueceu a senha?',
    title: 'Redefinir a senha local',
    intro:
      'A sua Frase de Recuperação define uma nova senha local neste dispositivo, mantendo tudo o que o cofre guarda aqui.',
    hint: 'Use a frase que este dispositivo conhece: se ela foi gerada de novo em outro dispositivo e este não sincronizou desde então, é a antiga.',
    next: 'Avançar',
    passwordIntro: 'Agora escolha a nova senha local deste dispositivo.',
    submit: 'Redefinir a senha',
    working: 'Redefinindo a senha…',
    wrongPhrase: 'Esta frase não abre o Envelope de Recuperação deste cofre.',
    masterKey:
      'Esta frase abre o Envelope de Recuperação guardado aqui, mas não este cofre: o armazenamento está danificado, ou alguém com a Chave Mestra o alterou. Substitua o cofre por um backup.',
    noEnvelope: 'Este cofre não tem Envelope de Recuperação para abrir. Substitua-o por um backup.',
    locked: 'A redefinição parou antes de salvar qualquer coisa. Tente de novo.',
  },
  replace: {
    choose: 'Substituir por um backup…',
    title: 'Substituir este cofre por um backup',
    warning:
      'O cofre deste dispositivo é apagado e substituído pelo backup, seja ele deste cofre ou de outro. As mudanças que só existem neste dispositivo se perdem. Se você ainda consegue desbloquear o cofre, faça um backup antes, em Configurações.',
    retire:
      'Depois, aposente o registro de dispositivo deste dispositivo a partir de outro dispositivo do cofre substituído: até lá, eles continuam a oferecê-lo para sincronizar. O nome dele não pode ser mostrado com o cofre bloqueado.',
    understand: 'Entendo que o cofre deste dispositivo será substituído',
    submit: 'Substituir',
    replacing: 'Substituindo o cofre…',
    leftoverPasskey:
      'A passkey do cofre substituído não desbloqueia mais nada: apague no seu gerenciador de passkeys a passkey "BlindVault" que você não usa mais.',
  },
  merge: {
    title: 'Mesclar um backup',
    intro:
      'Traz para este cofre os registros de um backup dele, como uma sincronização faria: a cópia mais nova de cada registro vence, e a versão mais antiga de um item vai para o histórico dele. Uma mesclagem não pode ser desfeita.',
    choose: 'Mesclar um backup…',
    confirm: 'Backup feito em {date}, verificado. Mesclá-lo neste cofre?',
    submit: 'Mesclar',
    merging: 'Mesclando…',
    done: 'Mesclado: {added} adicionados, {replaced} substituídos.',
    differentVault:
      'Este backup é de outro cofre. Ele não pode ser mesclado neste. Para substituir este cofre por ele, bloqueie e escolha Substituir por um backup.',
    masterKey:
      'Este backup tem o ID deste cofre, mas outra Chave Mestra. Ele não pode ser mesclado.',
    corruptRecord:
      'Este backup contém um registro que não é verificado: {type} {id}. Ele não pode ser mesclado.',
    immutable:
      'Este backup contém uma cópia alterada de um registro que nunca muda: {type} {id}. Ele não pode ser mesclado: só alguém com a Chave Mestra, ou um defeito, cria uma assim.',
    futureClock:
      'Este backup contém registros com data à frente do relógio deste dispositivo. Ele pode ser mesclado a partir de {date}.',
    locked: 'A mesclagem parou antes de salvar qualquer coisa. Abra o arquivo de novo.',
    phraseChanged:
      'A Frase de Recuperação foi gerada de novo em outro dispositivo: a nova, {id}, foi criada em {date}. Os novos backups só abrem com ela: confira a sua em Verificar a Frase de Recuperação, abaixo.',
    phraseSuperseded:
      'A Frase de Recuperação que você anotou para este dispositivo, {id}, criada em {date}, foi substituída por uma gerada de novo em outro dispositivo. Os backups feitos com ela só abrem com ela, então guarde-a até ter um novo backup. Os novos backups só abrem com a frase nova.',
    backupNow: 'Fazer um backup agora',
    newDevices:
      'Dispositivos que este dispositivo nunca tinha visto: {names}. Um dispositivo que você não pareou significa que alguém com a Chave Mestra o adicionou.',
    alreadyRetired: '{name} (já aposentado)',
    retiredDevices:
      'Dispositivos agora aposentados: {names}. Se não foi você quem os aposentou, foi alguém com a Chave Mestra.',
    droppedLosers:
      'Uma edição mais antiga feita neste dispositivo não cabe mais no histórico de: {titles}. Ela foi descartada.',
    ownRetired:
      'Este dispositivo foi aposentado do cofre. Para sincronizar de novo, substitua-o pareando com outro dispositivo. Se não foi você quem o aposentou, foi alguém com a Chave Mestra: refunde o cofre.',
  },
  create: {
    title: 'Criar um cofre',
    intro:
      'O BlindVault não tem servidor: ninguém pode redefinir o seu cofre. Seus dados ficam nos seus dispositivos.',
    password: 'Senha local',
    confirm: 'Repita a senha',
    submit: 'Criar cofre',
    working: 'Criando o cofre…',
    mismatch: 'As senhas não coincidem.',
    weak: 'Esta senha é fácil de adivinhar. Use uma frase-senha mais longa.',
    strong: 'Forte o bastante.',
    browserSave:
      'Não deixe o navegador salvar esta senha: dependendo do navegador, uma cópia dos dados dele poderia bastar para abrir o cofre.',
    phraseTitle: 'Sua Frase de Recuperação',
    phraseIntro:
      'Estas 24 palavras, junto com um backup, recuperam o cofre se você esquecer a senha local ou perder este dispositivo. O BlindVault não tem servidor, então ninguém mais pode recuperá-lo por você. Anote-as em papel, na ordem, e guarde em um lugar seguro.',
    phraseOnce: 'Elas aparecem só agora: o BlindVault não as guarda e não pode mostrá-las de novo.',
    phraseNoPhoto:
      'Não tire captura de tela nem foto: elas vão para a galeria e para o backup dela na nuvem.',
    phraseWritten: 'Já anotei',
    word: 'Palavra {n}',
    confirmTitle: 'Confirme a Frase de Recuperação',
    confirmIntro: 'Pelo que você anotou, digite as palavras nestas posições.',
    confirmSubmit: 'Confirmar',
    confirmWrong:
      'Essas palavras não conferem. Compare o que você anotou com a frase e confirme de novo.',
    passwordIntro: 'Por último, defina a senha local que desbloqueia o cofre neste dispositivo.',
  },
  unlock: {
    title: 'Desbloquear o cofre',
    password: 'Senha local',
    submit: 'Desbloquear',
    working: 'Desbloqueando…',
    wrong: 'Senha incorreta.',
    passkey: 'Desbloquear com passkey',
    passkeyCancelled: 'O pedido de passkey foi fechado. Tente de novo ou use a senha.',
    passkeyRejected: 'Esta passkey não desbloqueia este cofre. Use a senha.',
    passkeyNoVerification:
      'O autenticador não verificou você com PIN, digital ou rosto, então a passkey não desbloqueia. Use a senha.',
    passkeyUnavailable:
      'O autenticador não forneceu o que o BlindVault precisa para desbloquear. Use a senha.',
  },
  vault: {
    folders: 'Pastas',
    allItems: 'Todos os itens',
    items: 'Itens',
    detail: 'Detalhes',
    empty: 'Nenhum item ainda.',
    nothingSelected: 'Selecione um item.',
    trash: 'Lixeira',
    trashEmpty: 'A lixeira está vazia.',
    search: 'Buscar',
    searchHint: 'Busca em títulos, tags, pastas, notas e campos que não são secretos.',
    results: 'Resultados',
    noResults: 'Nenhum item corresponde.',
    readOnlyVault:
      'O cofre está somente leitura: um registro tem data à frente do relógio deste dispositivo. Confira o relógio.',
    reminderNever:
      'Nenhum backup foi feito neste dispositivo: faça um, para poder restaurar o cofre se perder este dispositivo.',
    reminderStale:
      'O último backup feito neste dispositivo é de {date}, há mais de 30 dias: faça um novo.',
    reminderOldPhrase:
      'Nenhum backup feito neste dispositivo abre com a Frase de Recuperação atual: faça um novo.',
    reminderBackup: 'Fazer um backup',
  },
  items: {
    new: 'Novo item',
    chooseTemplate: 'Escolha um modelo',
    title: 'Título',
    tags: 'Tags',
    tagsHint: 'Separe as tags com vírgulas.',
    notes: 'Notas',
    addField: 'Adicionar um campo',
    fieldLabel: 'Rótulo',
    fieldType: 'Tipo de campo',
    add: 'Adicionar',
    remove: 'Remover',
    save: 'Salvar',
    saving: 'Salvando…',
    cancel: 'Cancelar',
    edit: 'Editar',
    moveToTrash: 'Mover para a lixeira',
    restore: 'Restaurar',
    show: 'Mostrar',
    hide: 'Ocultar',
    open: 'Abrir',
    newerTitle: 'Item de uma versão mais nova',
    readOnlyNewer:
      'Este item foi salvo por uma versão mais nova do BlindVault. Atualize o app para editá-lo ou duplicá-lo.',
    readOnlyClock:
      'Este item tem data à frente do relógio deste dispositivo. Ele pode ser alterado quando o relógio chegar a essa data.',
    inTrash: 'Na lixeira. Ele só pode ser restaurado; será apagado de vez em {date}.',
    multiLine: 'Mostre o valor para digitar várias linhas.',
    checksum: 'O checksum desta frase-semente não confere. Confira as palavras.',
    duplicate: 'Duplicar',
    copySuffix: ' (cópia)',
    copyTitleTooLong: 'O título da cópia passaria de 512 caracteres. Encurte o título antes.',
    history: 'Histórico',
    historyTitle: 'Histórico de {title}',
    historyNote:
      'Valores antigos ficam neste histórico, em todos os dispositivos e nos backups seguintes, em até 20 versões. Para removê-los, duplique o item e mova o original para a lixeira: o histórico dele é apagado quando ele é apagado de vez da lixeira.',
    noHistory: 'Nenhuma versão anterior.',
    backToItem: 'Voltar ao item',
    restoreVersion: 'Restaurar esta versão',
    versionNewer: 'Salva por uma versão mais nova do BlindVault: não pode ser restaurada aqui.',
    versionClock:
      'Com data à frente do relógio deste dispositivo: pode ser restaurada quando o relógio chegar a essa data.',
    copy: 'Copiar',
    copyCode: 'Copiar código',
    copied:
      'Copiado. O BlindVault tenta limpar a área de transferência em {seconds} s enquanto estiver em foco; a limpeza não é garantida.',
    copyFailed: 'O navegador não permitiu copiar.',
    totpCode: 'Código atual',
    totpSecret: 'Segredo TOTP',
    totpExpires: 'Muda em {seconds} s',
    totpHint: 'Cole um link otpauth:// ou o segredo TOTP.',
    totpKeep: 'Deixe vazio para manter o segredo TOTP atual, ou cole um novo link ou segredo.',
    monthFormat: 'AAAA-MM',
    invalid: 'Corrija os campos marcados acima.',
    tooLarge: 'Este item é grande demais para salvar.',
    blocked: 'Este item não pode ser alterado agora.',
  },
  folders: {
    new: 'Nova pasta',
    newSubfolder: 'Nova subpasta',
    name: 'Nome da pasta',
    create: 'Criar',
    rename: 'Renomear',
    move: 'Mover',
    moveTo: 'Mover para',
    root: 'Sem pasta (raiz do cofre)',
    folder: 'Pasta',
    empty: 'Esta pasta está vazia.',
    trashNote: 'Mover uma pasta para a lixeira também move suas subpastas e os itens delas.',
    restoreNote: 'Restaurar uma pasta traz de volta o que foi para a lixeira com ela.',
    blocked: 'Nada foi alterado: estes registros estão somente leitura.',
    'newer-content': 'salvo por uma versão mais nova do BlindVault',
    'future-clock': 'com data à frente do relógio deste dispositivo',
    nameRequired: 'Digite um nome para a pasta.',
    nameTooLong: 'O nome passa de 256 caracteres.',
    nameSingleLine: 'O nome aceita uma única linha.',
    cycle: 'Uma pasta não pode ir para dentro de si mesma ou de uma subpasta.',
    failed: 'Esta pasta não pode ser alterada agora.',
  },
  errors: {
    titleRequired: 'Digite um título.',
    titleTooLong: 'O título passa de 512 caracteres.',
    tagsTooMany: 'Um item tem no máximo 32 tags.',
    tagTooLong: 'Uma tag passa de 64 caracteres.',
    'single-line': 'Este campo aceita uma única linha.',
    date: 'Digite uma data válida.',
    month: 'Digite um mês como AAAA-MM.',
    number: 'Digite um número, como 42 ou 3.5.',
    'seed-phrase': 'Use 12, 15, 18, 21 ou 24 palavras da lista BIP39 em inglês.',
    totp: 'Cole um link otpauth://totp/, ou um segredo TOTP com letras A–Z e dígitos 2–7.',
    'label-required': 'Digite um rótulo para este campo.',
    'label-too-long': 'O rótulo passa de 128 caracteres.',
  },
  fieldTypes: {
    text: 'Texto',
    'long-text': 'Texto longo',
    secret: 'Segredo',
    url: 'URL',
    email: 'E-mail',
    phone: 'Telefone',
    date: 'Data',
    number: 'Número',
    totp: 'TOTP',
    'seed-phrase': 'Frase-semente',
  },
  generator: {
    generate: 'Gerar',
    characters: 'Caracteres',
    words: 'Palavras',
    length: 'Tamanho (12–128)',
    wordCount: 'Palavras (4–24)',
    lowercase: 'a–z',
    uppercase: 'A–Z',
    digits: '0–9',
    symbols: 'Símbolos',
    entropy: '{bits} bits de entropia',
    unavailable: 'Escolha pelo menos 12 caracteres ou 4 palavras, e um conjunto de caracteres.',
    use: 'Usar esta senha',
  },
  settings: {
    title: 'Configurações',
    password: 'Trocar a senha local',
    current: 'Senha atual',
    next: 'Nova senha',
    confirm: 'Repita a nova senha',
    change: 'Trocar senha',
    changing: 'Trocando a senha…',
    changed: 'Senha trocada.',
    wrong: 'A senha atual está incorreta.',
    locking: 'Bloqueio',
    autoLock: 'Bloquear após inatividade (minutos, 1–60)',
    hiddenLock: 'Bloquear após o app ficar oculto (segundos, 0–900)',
    hiddenImmediate:
      'Com 0 o cofre bloqueia assim que o app fica oculto, inclusive durante um seletor de arquivos ou um pedido de passkey em alguns sistemas.',
    clipboard: 'Limpar a área de transferência após (segundos, 10–120)',
    save: 'Salvar',
    saved: 'Salvo.',
    outOfRange: 'Um valor está fora do intervalo.',
    language: 'Idioma',
    passkey: 'Desbloqueio com passkey',
    passkeyIntro:
      'Desbloqueie neste dispositivo com uma passkey em vez de digitar a senha local. A senha continua funcionando.',
    passkeyLostDevice:
      'Com uma passkey, quem estiver com este dispositivo precisa apenas do bloqueio de tela, da digital ou do rosto, ou do PIN da chave de segurança, não da senha local. Use um PIN forte no dispositivo.',
    passkeyPassword: 'Senha local',
    passkeySetUp: 'Configurar passkey',
    passkeySettingUp: 'Configurando a passkey…',
    passkeyOn: 'O desbloqueio com passkey está configurado neste dispositivo.',
    passkeyDone: 'Passkey configurada.',
    passkeySynced:
      'Esta passkey é sincronizada por uma conta de plataforma, como o Porta-chaves do iCloud ou o Gerenciador de Senhas do Google. Quem controlar essa conta e obtiver uma cópia do armazenamento deste dispositivo pode desbloquear o cofre sem este dispositivo: o cofre agora também depende da segurança dessa conta.',
    passkeyRemove: 'Remover passkey',
    passkeyRemoved: 'Passkey removida. O seu gerenciador de passkeys foi solicitado a apagá-la.',
    passkeyRemovedByHand:
      'Passkey removida. Ela não desbloqueia mais nada: apague a passkey "BlindVault" no seu gerenciador de passkeys.',
    passkeyCancelled: 'O pedido de passkey foi fechado, ou o cofre bloqueou. Nada foi configurado.',
    passkeyNoVerification:
      'O autenticador não verificou você, então nada foi configurado. Use uma passkey que peça PIN, digital ou rosto.',
    passkeyUnavailable:
      'Esta passkey não desbloqueia o BlindVault: o autenticador dela não tem a extensão PRF. Nada foi configurado.',
    passkeyUnsupported: 'Este navegador não oferece desbloqueio com passkey.',
    recovery: 'Frase de Recuperação',
    recoveryCreated: 'A Frase de Recuperação atual foi criada em {date} ({id}).',
    recoveryNoBackup:
      'Nenhum backup feito neste dispositivo abre com a Frase de Recuperação atual ainda: faça um em Backup, acima.',
    regenTitle: 'Gerar uma nova Frase de Recuperação',
    regenIntro:
      'Se você perdeu a Frase de Recuperação, gere uma nova com o cofre desbloqueado: a nova frase substitui a atual, e nada no cofre muda.',
    regenExposed:
      'Gerar uma nova frase não adianta se outra pessoa viu ou copiou a atual: ela continua abrindo todos os backups feitos com ela e o Envelope de Recuperação de qualquer dispositivo que ainda não sincronizou, e assim entrega a Chave Mestra. Uma frase exposta exige refundar o cofre.',
    regenBackups:
      'Os backups feitos até agora só abrem com a frase atual. Os seus outros dispositivos continuam com ela, e continuam fazendo backups para ela, até sincronizarem com este.',
    regenStart: 'Gerar uma nova Frase de Recuperação…',
    regenContinue: 'Mostrar a nova frase',
    regenCancel: 'Cancelar',
    regenPhraseTitle: 'Sua nova Frase de Recuperação',
    regenAuthIntro:
      'A nova frase recupera a Chave Mestra, então gerar uma nova pede a sua senha local de novo.',
    regenAuth: 'Senha local',
    regenSubmit: 'Gerar a nova frase',
    regenWorking: 'Gerando a nova frase…',
    regenPasskey: 'Gerar com a passkey',
    regenWrong: 'Senha incorreta. A Frase de Recuperação não mudou.',
    regenPasskeyCancelled: 'O pedido de passkey foi fechado. A Frase de Recuperação não mudou.',
    regenPasskeyFailed: 'A passkey não abriu o cofre. Use a senha.',
    regenDone: 'A nova Frase de Recuperação foi gerada: {id}, criada em {date}.',
    regenOtherDevices:
      'A nova frase ainda não está nos seus outros dispositivos: eles a recebem quando sincronizarem com este, e até lá os backups deles só abrem com a frase anterior.',
    regenOldBackups:
      'Os backups feitos antes de agora só abrem com a frase anterior. Faça um novo backup agora.',
    regenBackupNow: 'Fazer um backup agora',
    regenNewer:
      'O Envelope de Recuperação foi gravado por uma versão mais nova do BlindVault. Atualize o app para gerar uma nova Frase de Recuperação.',
    regenFutureClock:
      'O Envelope de Recuperação tem data à frente do relógio deste dispositivo. Uma nova Frase de Recuperação pode ser gerada a partir de {date}.',
    regenReadOnly:
      'O relógio deste dispositivo voltou, então o cofre está somente leitura. Uma nova Frase de Recuperação pode ser gerada a partir de {date}.',
    recoveryIntro:
      'Digite as 24 palavras que você anotou para confirmar que elas abrem este cofre e os backups dele. Nada do que você digita é guardado.',
    recoveryInput: 'Suas 24 palavras',
    recoveryCheck: 'Verificar a Frase de Recuperação',
    recoveryOpens: 'Esta frase abre este cofre e os backups dele.',
    recoveryWrong: 'Esta não é a Frase de Recuperação atual deste cofre.',
    recoveryPublicKey:
      'Esta frase abre o cofre, mas os backups não abrem com ela. Gere uma nova Frase de Recuperação e depois faça um novo backup.',
    recoveryMasterKey:
      'Esta frase abre um Envelope de Recuperação que não recupera este cofre, então os backups não podem ser restaurados com ela. Gere uma nova Frase de Recuperação e depois faça um novo backup.',
    recoveryWordCount: 'Uma Frase de Recuperação tem 24 palavras.',
    recoveryUnknownWord: 'A palavra {n} não é uma palavra de Frase de Recuperação.',
    recoveryChecksum:
      'Estas palavras não formam uma Frase de Recuperação válida. Confira cada uma com o que você anotou.',
    recoveryNone:
      'Este cofre não tem Frase de Recuperação: a versão de prévia o criou, e ele não pode ser recuperado. Crie um novo cofre para ter uma.',
    recoveryCorrupt:
      'O Envelope de Recuperação neste dispositivo está danificado, então a Frase de Recuperação não pode ser verificada. Gere uma nova Frase de Recuperação para substituí-lo.',
    backup: 'Backup',
    backupIntro:
      'Um backup é um arquivo criptografado com uma cópia completa deste cofre. A sua Frase de Recuperação sempre o abre. Guarde cópias fora deste dispositivo, para poder restaurar se perdê-lo.',
    backupLast: 'Último backup feito neste dispositivo: {date}.',
    backupNever: 'Nenhum backup foi feito neste dispositivo ainda.',
    backupIncomplete:
      'Alguns registros de outros dispositivos foram rejeitados porque precisam de uma versão mais nova do app, então este backup pode estar incompleto. Atualize o app e sincronize com eles antes.',
    backupNone:
      'Este cofre não tem Frase de Recuperação: a versão de prévia o criou, então nenhum backup dele poderia ser aberto. Crie um novo cofre para ter uma.',
    backupProtect: 'Proteger também com uma senha de exportação',
    backupMasterKey:
      'Quem abrir este backup com a senha de exportação passa a ter a Chave Mestra do cofre para sempre. Se a senha de exportação e uma cópia do backup forem expostas juntas, o cofre precisará ser refundado.',
    exportPassword: 'Senha de exportação',
    exportConfirm: 'Repita a senha de exportação',
    exportGenerate: 'Gerar uma frase-senha',
    exportGenerated:
      'Anote esta frase-senha: ela abre o backup sem a Frase de Recuperação, e o BlindVault não a guarda.',
    exportWeak:
      'Fácil demais de adivinhar para um arquivo que pode ser atacado offline. Use uma senha mais longa ou gere uma frase-senha.',
    exportStrong: 'Forte o bastante para um backup.',
    backupAuth: 'Senha local',
    backupAuthIntro:
      'Um backup contém a Chave Mestra do cofre, então exportar pede a sua senha local de novo.',
    backupExport: 'Exportar',
    backupExporting: 'Exportando…',
    backupPasskey: 'Exportar com a passkey',
    backupDone:
      'Backup exportado como {name}. Ele abre com a Frase de Recuperação {id}, criada em {date}. Guarde-o em outro lugar além deste dispositivo.',
    backupWrong: 'Senha incorreta. Nenhum backup foi feito.',
    backupCorrupt:
      'Um registro falhou na verificação, então nenhum backup foi feito: {type} {id}. Nada foi alterado neste dispositivo.',
    backupPasskeyCancelled: 'O pedido de passkey foi fechado. Nenhum backup foi feito.',
    backupPasskeyRejected: 'Esta passkey não abre este cofre. Use a senha.',
    backupPasskeyNoVerification:
      'O autenticador não verificou você com PIN, digital ou rosto. Use a senha.',
    backupPasskeyUnavailable:
      'O autenticador não forneceu o que o BlindVault precisa. Use a senha.',
    backupHidden:
      'O cofre bloqueia assim que o app fica oculto: se o navegador o ocultar enquanto salva o arquivo, o cofre bloqueia e a exportação precisa ser repetida.',
    devices: 'Dispositivos',
    devicesThis: '{name} (este dispositivo)',
    devicesRegistered: 'Registrado em {date}',
    devicesRetiredCount: 'Dispositivos aposentados, não mostrados: {n}.',
    devicesReadmit:
      'Este dispositivo não está registrado: ele foi restaurado de um backup, e os outros dispositivos não o conhecem. Até que um dos dispositivos abaixo o readmita, ele troca dados com eles só por backups.',
    devicesOnly:
      'Este é o único dispositivo deste cofre. Se este navegador perder o armazenamento, só um backup e a Frase de Recuperação trazem o cofre de volta: faça um backup e pareie outro dispositivo.',
    devicesRetire: 'Aposentar',
    devicesRetireWarning:
      'Aposentar {name}? Não dá para desfazer. Aposentar não é revogar: o que esse dispositivo já tem continua legível para quem estiver com ele. Se ele pode estar nas mãos de outra pessoa, refunde o cofre.',
    devicesRetireConfirm: 'Aposentar {name}',
    devicesRetireCancel: 'Cancelar',
    devicesRetired: '{name} foi aposentado.',
    devicesRefused:
      'Esse dispositivo não pode ser aposentado: é este dispositivo, ou já está aposentado.',
    recordTypes: {
      item: 'Item',
      folder: 'Pasta',
      itemVersion: 'Versão do item',
      vaultKey: 'Chave do Cofre',
      recoveryEnvelope: 'Envelope de Recuperação',
      device: 'Registro de dispositivo',
    },
  },
  refound: {
    title: 'Refundar o cofre',
    intro:
      'Se outra pessoa pode ter a Chave Mestra (uma Frase de Recuperação ou senha de exportação exposta, uma aposentadoria que você não fez, um dispositivo que você não pareou), refunde o cofre: o que este dispositivo tem passa para um cofre novo, com chaves totalmente novas.',
    start: 'Refundar o cofre…',
    warnSync:
      'Antes, sincronize este dispositivo com todos os outros que ainda estão com você: as alterações que não estão neste dispositivo se perdem. Depois, pareie de novo cada um dos outros dispositivos com o cofre novo e destrua os backups do cofre antigo: eles ainda o abrem com a Frase de Recuperação antiga.',
    warnRetired:
      'Este dispositivo foi aposentado, então não pode sincronizar antes: as alterações que só existem em outros dispositivos se perdem. Se um dispositivo não aposentado ainda está com você, refunde por ele.',
    warnTrash:
      'A lixeira e o histórico de todos os itens são esvaziados. Antes, restaure da lixeira o que você ainda precisar.',
    openTrash: 'Abrir a lixeira',
    warnCorrupt: 'Registros que este dispositivo não consegue ler e que não são levados: {n}.',
    warnCopied:
      'Refundar protege só o que acontece depois: quem já copiou o cofre antigo continua com ele.',
    warnRejected:
      'Este dispositivo recusou registros de {names}, feitos por uma versão mais nova do app. Eles não estão neste dispositivo e serão perdidos: atualize o app e sincronize com esses dispositivos antes.',
    understand:
      'Entendo que as alterações que não estão neste dispositivo, a lixeira e o histórico se perdem, e que os outros dispositivos e os backups antigos ficam com o cofre antigo.',
    understandRejected: 'Entendo que os registros de {names} se perdem.',
    continue: 'Continuar',
    authIntro: 'Confirme que é você com a senha local deste cofre, ou com a passkey dele.',
    auth: 'Senha local',
    authSubmit: 'Confirmar',
    authPasskey: 'Usar a passkey',
    wrong: 'Senha incorreta.',
    passkeyCancelled: 'O pedido de passkey foi fechado.',
    passkeyFailed: 'A passkey não abriu o cofre. Use a senha.',
    phraseTitle: 'A Frase de Recuperação do cofre novo',
    passwordIntro: 'Escolha a senha local do cofre novo neste dispositivo.',
    password: 'Nova senha local',
    confirmPassword: 'Repita a nova senha local',
    submit: 'Refundar',
    working: 'Refundando o cofre…',
    busy: 'O BlindVault está ocupado em outra janela. Tente de novo quando ela terminar.',
    cancel: 'Cancelar',
    done: 'O cofre foi refundado. Faça agora um backup do cofre novo, pareie de novo os outros dispositivos com ele e destrua os backups do cofre antigo. Uma passkey pode ser configurada de novo em Configurações.',
  },
  templates: {
    login: 'Login',
    'secure-note': 'Nota segura',
    card: 'Cartão de pagamento',
    identity: 'Identidade',
    'developer-credential': 'Credencial de desenvolvedor',
    'crypto-wallet': 'Carteira de criptomoedas',
    document: 'Documento',
  },
  roles: {
    'login.username': 'Usuário',
    'login.password': 'Senha',
    'login.url': 'Site',
    'card.cardholder': 'Titular',
    'card.number': 'Número do cartão',
    'card.expiry': 'Validade',
    'card.cvv': 'Código de segurança',
    'card.pin': 'PIN',
    'identity.firstName': 'Nome',
    'identity.lastName': 'Sobrenome',
    'identity.birthDate': 'Data de nascimento',
    'identity.email': 'E-mail',
    'identity.phone': 'Telefone',
    'identity.address': 'Endereço',
    'developer-credential.provider': 'Provedor',
    'developer-credential.baseUrl': 'URL base',
    'developer-credential.keyId': 'ID da chave',
    'developer-credential.secret': 'Segredo',
    'crypto-wallet.walletName': 'Nome da carteira',
    'crypto-wallet.network': 'Rede',
    'crypto-wallet.seedPhrase': 'Frase-semente',
    'crypto-wallet.passphrase': 'Frase-senha',
    'crypto-wallet.derivationPath': 'Caminho de derivação',
    'crypto-wallet.address': 'Endereço da carteira',
    'document.documentType': 'Tipo de documento',
    'document.number': 'Número do documento',
    'document.fullName': 'Nome completo',
    'document.issuer': 'Emissor',
    'document.issueDate': 'Data de emissão',
    'document.expiryDate': 'Data de validade',
  },
};

export const LANGUAGES = ['en', 'pt-BR'] as const;
export type Language = (typeof LANGUAGES)[number];

export const MESSAGES: Record<Language, Messages> = { en, 'pt-BR': ptBR };

/** The first supported language of the browser's list, by primary subtag; `en` otherwise. */
export function pickLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const primary = tag.toLowerCase().split('-')[0];
    if (primary === 'pt') return 'pt-BR';
    if (primary === 'en') return 'en';
  }
  return 'en';
}

/** `text` with each `{name}` replaced by `values[name]`. */
export function format(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** The localized name of a template role, or `undefined` for one this app does not know. */
export function roleName(m: Messages, templateId: string, role: string): string | undefined {
  const key = `${templateId}.${role}`;
  return Object.hasOwn(m.roles, key) ? m.roles[key as keyof Messages['roles']] : undefined;
}
