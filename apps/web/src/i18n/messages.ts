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
  storage: {
    title: 'This device',
    kept: 'The browser keeps this vault’s storage, even when space runs low.',
    notKept:
      'The browser may delete this vault’s storage when space runs low. Browser storage is never permanent: keep a recent backup.',
    unknown: 'This browser does not say whether it keeps this vault’s storage.',
    usage: 'Storage used by BlindVault on this device: {used} of {quota} available ({percent}).',
    usageUnknown: 'This browser does not report how much storage BlindVault uses.',
    ask: 'Ask the browser to keep the storage',
    refused:
      'The browser did not agree to keep the storage. Browsers decide this by their own rules, such as an installed app or a site used often.',
    safariTab:
      'Safari may delete this vault after seven days of Safari use without opening BlindVault. Install the app (Share → Add to Home Screen on iPhone and iPad, File → Add to Dock on a Mac) and move the vault to it: installing does not take this vault along, so pair the installed app with this tab, or restore a backup in it.',
    safariTabNoVault:
      'Safari may delete what you create in this tab after seven days of Safari use without opening BlindVault. Install the app (Share → Add to Home Screen on iPhone and iPad, File → Add to Dock on a Mac) and start there: the installed app does not share this tab’s storage.',
    notKeptOnly:
      'The browser may delete this vault’s storage, and this is the only device of the vault: if it does, only a backup and the Recovery Phrase bring the vault back. Make a backup, and pair another device.',
    nearlyFull:
      'Storage on this device is nearly full: BlindVault uses {percent} of what the browser allows. Free some space, or the browser may refuse to save changes.',
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
      'BlindVault has no account and no server: your vault lives only on your devices and in your backups.',
    noReset:
      'Nobody, BlindVault included, can reset your local password or recover your vault for you.',
    recoveryOnly: 'Your Recovery Phrase and a backup are the only way to get the vault back.',
    create: 'Create a new vault',
    pair: 'Pair with an existing device',
    restore: 'Restore from a backup',
    installTitle: 'Install BlindVault first',
    installWhy:
      'In Safari, the installed app does not share this tab’s storage: a vault created here stays in this tab, and Safari may delete it after seven days of Safari use without opening BlindVault.',
    installHow:
      'Share → Add to Home Screen on iPhone and iPad, File → Add to Dock on a Mac. Then open BlindVault from there.',
    continueTab: 'Continue in this tab',
  },
  pairing: {
    title: 'Pair a new device',
    intro:
      'The new device gets this whole vault. On it, open BlindVault and choose “Pair with an existing device”.',
    start: 'Pair a new device…',
    auth: 'Pairing hands this vault’s Master Key to the new device for good: enter the local password again.',
    password: 'Local password',
    begin: 'Start pairing',
    passkey: 'Use the passkey',
    wrong: 'That password does not open this vault.',
    passkeyCancelled: 'The passkey prompt was closed. Nothing was started.',
    passkeyFailed: 'The passkey did not open this vault. Use the password.',
    unavailable: 'This browser cannot pair: it offers no WebRTC.',
    readOnly:
      'The device clock went back, so the vault is read-only: pairing comes back once writing does.',
    retired: 'This device was retired: it cannot pair another device.',
    corrupt:
      'This device holds a record it cannot read: pairing would hand it on. Re-found the vault or restore a backup.',
    sameNetwork: 'Same network only (no STUN server)',
    sameNetworkHint:
      'Both devices must then be on the same network. Otherwise a STUN server ({hosts}) sees this device’s public address.',
    preparing: 'Preparing the connection…',
    offerIntro:
      'Scan this code with the new device in its pairing screen, or copy the text to it. Then scan or paste its answer below.',
    offerLabel: 'This device’s pairing text',
    qrLabel: 'This device’s code, for the other device to scan',
    copy: 'Copy',
    copied: 'Copied',
    channel:
      'Whoever sees this code, or whatever carries this text, a message or an email, sees this device’s network addresses. Nothing else: the numbers compared next protect the pairing.',
    scan: 'Scan with the camera',
    scanStop: 'Stop the camera',
    scanning: 'Point the camera at the code the other device shows.',
    noCamera: 'This device has no camera: paste the text.',
    cameraDenied: 'The camera was denied: allow it in the browser settings, or paste the text.',
    cameraFailed: 'The camera did not start: paste the text.',
    readerFailed: 'The code reader did not load: paste the text.',
    leaving:
      'Leaving BlindVault to copy or paste counts as hiding it: if it stays hidden for {seconds} seconds, the pairing ends.',
    leavingImmediate:
      'This vault locks as soon as BlindVault is hidden, which ends the pairing: copy and paste without leaving the app, or change the hidden-app lock below.',
    answerPaste: 'The new device’s answer',
    connect: 'Connect',
    connecting: 'Connecting…',
    sasTitle: 'Compare the numbers',
    sasQuestion: 'Does the other device show exactly this number?',
    match: 'Yes, the same',
    differ: 'No, it differs',
    waiting: 'Waiting for the other device…',
    sending: 'Sending the vault…',
    done: '{name} is paired: it holds this vault now.',
    readmit:
      'The other devices of this vault do not know this device or {name} yet: re-admit this device with one of them, so they can sync with both.',
    close: 'Done',
    again: 'Start again',
    cancel: 'Cancel',
    pasteInvalid: 'This is not a BlindVault pairing text. Copy it again, whole.',
    pasteVersion: 'This text comes from another version of BlindVault: update both devices.',
    pasteWrongSession:
      'This answer belongs to another pairing: paste the answer to the text above.',
    pasteOutdated:
      'The new device runs a BlindVault that cannot hold this vault: update the app there, then pair again.',
    pastePeerHoldsVault:
      'That device already holds a vault: to re-admit it, cancel here and choose “Re-admit with another device of this vault…” on both devices.',
    pastePeerNoVault:
      'This text comes from a device with no vault: start the pairing on the device that holds the vault.',
    failed: {
      cancelled: 'The pairing was cancelled on this device.',
      cancelledRemote: 'The pairing was cancelled on the other device.',
      sasMismatch:
        'The numbers differ, so the pairing stopped and nothing was sent. Someone may have changed the texts on the way: pair again, and carry them some other way.',
      locked: 'A vault locked, or BlindVault stayed hidden too long, so the pairing stopped.',
      expired: 'The pairing took too long and expired.',
      retiredPeer:
        'The device holding the vault was retired, so no device can join through it: pair with another device of the vault.',
      differentVaults: 'The two devices hold different vaults.',
      unsupportedFormat:
        'The vault holds records this BlindVault cannot read: update the app on the new device, then pair again.',
      verificationFailed:
        'A record failed verification, so the pairing stopped and the new device kept nothing.',
      version: 'The devices run versions of BlindVault that cannot pair: update both.',
      protocolError: 'The other device sent something unexpected, so the pairing stopped.',
      closed: 'The connection closed, so the pairing stopped.',
    },
  },
  stun: {
    open: 'STUN servers…',
    intro:
      'Unless the same network only is chosen, this device asks these STUN servers for its public address. Each one sees that address, and nothing of the vault.',
    defaults: 'These are the defaults, Google and Cloudflare.',
    edit: 'Edit',
    label: 'STUN servers, one per line, like stun:stun.example.org:3478',
    save: 'Save',
    cancel: 'Cancel',
    reset: 'Restore the defaults',
    unreadable:
      'The STUN list stored on this device cannot be read, so no STUN server is used and both devices must be on the same network: fix the list or restore the defaults.',
    notSaved: 'This browser did not save the list.',
    problems: {
      scheme: '“{url}” is not a STUN server: write stun:host or stun:host:port. TURN is not used.',
      query: '“{url}”: nothing after “?” is accepted.',
      host: '“{url}” has no valid host name or address. Write an IPv6 address in brackets.',
      port: '“{url}” has a port outside 1 to 65535.',
      tooLong: '“{url}” is longer than 255 characters.',
      empty: 'Enter at least one STUN server, or choose the same network only.',
      tooMany: 'At most 8 STUN servers.',
    },
  },
  join: {
    title: 'Pair with an existing device',
    intro:
      'This device gets the vault of a device that holds it. First create this device’s local password; then, on the other device, open Settings → Devices → “Pair a new device”.',
    submit: 'Continue',
    scanIntro: 'Scan the code the other device shows, or paste its pairing text here.',
    offerPaste: 'The other device’s pairing text',
    next: 'Continue',
    answerIntro:
      'Show this code to the other device, which scans it below its own, or copy this answer back to it.',
    answerLabel: 'This device’s answer',
    waitingConnection: 'Waiting for the other device to connect…',
    receiving: 'Receiving the vault…',
  },
  readmission: {
    title: 'Re-admission',
    intro:
      'Two devices of this vault get to know each other and merge everything they hold, both ways: a device restored from a backup becomes registered, and two devices that never synced meet. No key leaves either device.',
    start: 'Re-admit with another device of this vault…',
    how: 'On the other device, open Settings → Devices → “Re-admit with another device of this vault…” too. One device shows its text first; the other pastes it.',
    first: 'Show this device’s text first',
    paste: 'Paste the other device’s text',
    readOnly:
      'The device clock went back, so the vault is read-only: re-admission comes back once writing does.',
    retired: 'This device was retired: it cannot be re-admitted. Replace it by pairing to sync.',
    corrupt:
      'This device holds a record it cannot read: re-admission would hand it on. Re-found the vault or restore a backup.',
    offerIntro:
      'Scan this code with the other device in its re-admission screen, or copy the text to it. Then scan or paste its answer below.',
    answerPaste: 'The other device’s answer',
    scanIntro: 'Scan the code the other device shows, or paste its re-admission text here.',
    offerPaste: 'The other device’s re-admission text',
    answerIntro:
      'Show this code to the other device, which scans it below its own, or copy this answer back to it.',
    merging: 'Merging the two devices…',
    done: 'Re-admitted with {name}: both devices know each other and hold the same records.',
    notCommitted:
      'This device merged, but the other may not have finished: check it there. Re-admitting again is safe.',
    rejected:
      '{n} records from the other device were rejected and not merged: {records}. The rest merged.',
    rejectedNoKey: 'a record that does not decode',
    rejectedReasons: {
      'verification-failed': 'does not verify',
      'future-clock': 'dated ahead of this device’s clock',
      'immutable-record': 'a changed copy of a record that never changes',
    },
    pastePeerNoVault:
      'This text comes from a device with no vault: pair it instead, with “Pair a new device…”.',
    failed: {
      cancelled: 'The re-admission was cancelled on this device.',
      cancelledRemote: 'The re-admission was cancelled on the other device.',
      sasMismatch:
        'The numbers differ, so the re-admission stopped and nothing was sent. Someone may have changed the texts on the way: start again, and carry them some other way.',
      locked: 'A vault locked, or BlindVault stayed hidden too long, so the re-admission stopped.',
      expired: 'The re-admission took too long and expired.',
      retiredPeer:
        'One of the two devices was retired, so the re-admission stopped: re-admit with another device of the vault.',
      differentVaults:
        'The two devices hold different vaults, and nothing was written. To make one of them hold this vault, lock it and choose “Replace by pairing with another device…” on its unlock screen.',
      unsupportedFormat:
        'The other device holds records this BlindVault cannot read: update the app on this device, then re-admit again.',
      unsupportedFormatRemote:
        'This device holds records the other device’s BlindVault cannot read: update the app there, then re-admit again.',
      verificationFailed:
        'A stored record failed verification, so the re-admission stopped before the merge.',
      version: 'The devices run versions of BlindVault that cannot re-admit: update both.',
      protocolError: 'The other device sent something unexpected, so the re-admission stopped.',
      closed: 'The connection closed, so the re-admission stopped.',
    },
  },
  sync: {
    start: 'Sync',
    title: 'Sync with {name}',
    notifyTitle: 'Tell {name} it is retired',
    notifyHow:
      'On {name}, open Settings → Devices and choose “Sync” next to this device. This device sends {name} only its retired record, and the sync ends: {name} then shows that it was retired and stops syncing.',
    how: 'On {name}, open Settings → Devices and choose “Sync” next to this device too. One device shows its code first; the other scans or pastes it.',
    first: 'Show this device’s code first',
    read: 'Read the code of {name}',
    cancel: 'Cancel',
    unavailable: 'This browser cannot sync: it offers no WebRTC.',
    refused: {
      unregistered:
        'This device has no Device record of its own yet: re-admit it with another device of this vault first.',
      retired: 'This device was retired: it cannot sync. Replace it by pairing.',
      'unknown-peer':
        'This device does not know {name}: sync first with the device that paired it.',
      'retired-peer': '{name} was retired: it cannot sync.',
      'not-retired': '{name} is not retired.',
    },
    offerIntro:
      'Scan this code with {name} in its sync screen, or copy the text to it. Then scan or paste its answer below.',
    offerLabel: 'This device’s sync text',
    answerPaste: 'The answer of {name}',
    connect: 'Connect',
    scanIntro: 'Scan the code {name} shows, or paste its sync text here.',
    offerPaste: 'The sync text of {name}',
    next: 'Next',
    answerIntro:
      'Show this code to {name}, which scans it below its own, or copy this answer back to it.',
    answerLabel: 'This device’s answer',
    channel:
      'This code is encrypted for {name}: whoever sees it, or whatever carries the text, learns only that a code was sent.',
    waiting: 'Waiting for the connection…',
    preparing: 'Preparing the connection…',
    connecting: 'Connecting…',
    connected:
      'Connected to {name}, its identity verified. Exchanging records comes in a later version: close the sync here.',
    close: 'Close',
    again: 'Start again',
    leaving:
      'Leaving BlindVault to copy or paste counts as hiding it: if it stays hidden for {seconds} seconds, the sync ends.',
    leavingImmediate:
      'This vault locks as soon as BlindVault is hidden, which ends the sync: copy and paste without leaving the app, or change the hidden-app lock below.',
    paste: {
      malformed: 'This is not a whole BlindVault sync text. Copy it again, whole.',
      version: 'This text comes from another version of BlindVault: update both devices.',
      'not-from-peer':
        'This code is not from {name} for this device: check that each device chose the other.',
    },
    failed: {
      expired: 'The sync took too long and expired.',
      closed: 'The connection closed, so the sync stopped.',
      error: 'The connection could not be set up, so the sync stopped.',
      unverified:
        'This device could not verify {name}, so the sync stopped. Make a new code on both devices.',
      ended: '{name} ended the sync.',
      locked: '{name} locked its vault, so the sync stopped.',
      version:
        '{name} runs another version of BlindVault, so the sync stopped: update both devices.',
      'protocol-error':
        '{name} sent something this device does not expect, so the sync stopped. Update both devices and try again.',
      'retired-peer':
        '{name} is retired: this device told it so and sent it nothing else, and the sync ended.',
      retired:
        '{name} holds this device as retired, so the sync ended. This device can no longer sync.',
      'verification-failed':
        'The record of {name} on this device failed verification, so nothing was sent and the sync stopped.',
    },
  },
  ready: {
    title: 'Vault ready',
    intro: 'Your vault is on this device. Before you start:',
    passkey: 'Unlock with a passkey instead of typing the local password.',
    passkeyAction: 'Set up a passkey',
    checkPhrase:
      'This vault was restored with an export password: check that your Recovery Phrase still opens it.',
    checkPhraseAction: 'Check the Recovery Phrase',
    readmitAction: 'See the devices',
    pair: 'Pair another device, so the vault has a second copy that stays in sync.',
    pairAction: 'Pair a device',
    backup:
      'Make a backup and keep it off this device: with the Recovery Phrase, it brings the vault back if this device is lost.',
    backupAction: 'Make a backup',
    open: 'Open the vault',
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
    pairChoose: 'Replace by pairing with another device…',
    pairTitle: 'Replace this vault by pairing',
    pairWarning:
      'The vault on this device is deleted and replaced by the vault of the device you pair with, whether it is this vault or another one. Changes that exist only on this device are lost. If you can still unlock the vault, make a backup first, in Settings.',
    understand: 'I understand that the vault on this device will be replaced',
    submit: 'Replace',
    replacing: 'Replacing the vault…',
    leftoverPasskey:
      'The passkey of the replaced vault no longer unlocks anything: delete the "BlindVault" passkey you no longer use in your passkey manager.',
  },
  erase: {
    choose: 'Erase this vault from this device…',
    title: 'Erase this vault from this device',
    intro:
      'Removes the vault and its local settings from this device only. Other devices and backups keep their copy.',
    warning:
      'Changes that exist only on this device are lost. Make a backup first, if you can still unlock the vault.',
    onlyDevice: 'This is the only device holding the vault: without a backup, it is lost for good.',
    named:
      'Afterwards, retire this device\'s Device record, "{name}", from another device: until then they keep offering it as a sync peer.',
    locked:
      "Afterwards, retire this device's Device record from another device: until then they keep offering it as a sync peer. Its name cannot be shown while the vault is locked.",
    unregistered: 'This device has no Device record left to retire.',
    understand: 'I understand that the vault on this device will be erased',
    submit: 'Erase',
    cancel: 'Cancel',
    erasing: 'Erasing the vault…',
    backupNow: 'Make a backup now',
    busy: 'BlindVault is busy in another window. Nothing was erased.',
    failed: 'The vault could not be erased. It is still on this device, locked.',
    done: 'The vault was erased from this device.',
    leftoverPasskey:
      'The passkey of the erased vault no longer unlocks anything: delete the "BlindVault" passkey you no longer use in your passkey manager.',
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
    clockBehind:
      "This device's clock went back, so the vault is read-only until {date}. Sync still receives records.",
    clockFar:
      'Changes made while the clock was wrong exist only on this device, since your other devices rejected them, and stay readable so you can copy them by hand. To write before then, re-found the vault.',
    clockPairAgain:
      'Or pair this device again from another one: lock, then choose “Replace by pairing with another device…”.',
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
    devicesLastSync: 'Last synced with this device: {date}',
    devicesNeverSynced: 'Last synced with this device: never',
    devicesPending:
      'Pairing not completed: this device never got the confirmation that the other one kept the vault.',
    devicesPendingRetire:
      'Before retiring {name}, look at it: if it shows the vault, the pairing succeeded, and only its confirmation was lost.',
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
    devicesRetiredList: 'Retired devices',
    devicesRetiredNotify:
      'A retired device learns it is retired only when told: sync with it from here, and it receives only its retired record.',
    devicesNotify: 'Tell {name}',
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
  storage: {
    title: 'Este dispositivo',
    kept: 'O navegador mantém o armazenamento deste cofre, mesmo quando falta espaço.',
    notKept:
      'O navegador pode apagar o armazenamento deste cofre quando faltar espaço. O armazenamento do navegador nunca é permanente: tenha um backup recente.',
    unknown: 'Este navegador não informa se mantém o armazenamento deste cofre.',
    usage:
      'Espaço usado pelo BlindVault neste dispositivo: {used} de {quota} disponíveis ({percent}).',
    usageUnknown: 'Este navegador não informa quanto espaço o BlindVault usa.',
    ask: 'Pedir ao navegador para manter o armazenamento',
    refused:
      'O navegador não aceitou manter o armazenamento. Os navegadores decidem isso por regras próprias, como uma app instalada ou um site usado com frequência.',
    safariTab:
      'O Safari pode apagar este cofre depois de sete dias de uso do Safari sem abrir o BlindVault. Instale a app (Compartilhar → Adicionar à Tela de Início no iPhone e no iPad, Arquivo → Adicionar ao Dock no Mac) e passe o cofre para ela: instalar não leva este cofre junto, então pareie a app instalada com esta aba ou restaure um backup nela.',
    safariTabNoVault:
      'O Safari pode apagar o que você criar nesta aba depois de sete dias de uso do Safari sem abrir o BlindVault. Instale a app (Compartilhar → Adicionar à Tela de Início no iPhone e no iPad, Arquivo → Adicionar ao Dock no Mac) e comece por lá: a app instalada não compartilha o armazenamento desta aba.',
    notKeptOnly:
      'O navegador pode apagar o armazenamento deste cofre, e este é o único dispositivo do cofre: se isso acontecer, só um backup e a Frase de Recuperação trazem o cofre de volta. Faça um backup e pareie outro dispositivo.',
    nearlyFull:
      'O espaço neste dispositivo está quase cheio: o BlindVault usa {percent} do que o navegador permite. Libere espaço, ou o navegador pode recusar salvar alterações.',
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
      'O BlindVault não tem conta nem servidor: seu cofre existe só nos seus dispositivos e nos seus backups.',
    noReset:
      'Ninguém, nem o BlindVault, consegue redefinir sua senha local ou recuperar seu cofre por você.',
    recoveryOnly: 'Sua Frase de Recuperação e um backup são o único jeito de recuperar o cofre.',
    create: 'Criar um cofre novo',
    pair: 'Parear com um dispositivo existente',
    restore: 'Restaurar de um backup',
    installTitle: 'Instale o BlindVault primeiro',
    installWhy:
      'No Safari, a app instalada não compartilha o armazenamento desta aba: um cofre criado aqui fica nesta aba, e o Safari pode apagá-lo depois de sete dias de uso do Safari sem abrir o BlindVault.',
    installHow:
      'Compartilhar → Adicionar à Tela de Início no iPhone e no iPad, Arquivo → Adicionar ao Dock no Mac. Depois abra o BlindVault por lá.',
    continueTab: 'Continuar nesta aba',
  },
  pairing: {
    title: 'Parear um dispositivo novo',
    intro:
      'O dispositivo novo recebe este cofre inteiro. Nele, abra o BlindVault e escolha “Parear com um dispositivo existente”.',
    start: 'Parear um dispositivo novo…',
    auth: 'Parear entrega a Chave Mestra deste cofre ao dispositivo novo para sempre: digite a senha local de novo.',
    password: 'Senha local',
    begin: 'Começar o pareamento',
    passkey: 'Usar a passkey',
    wrong: 'Essa senha não abre este cofre.',
    passkeyCancelled: 'O pedido de passkey foi fechado. Nada foi iniciado.',
    passkeyFailed: 'A passkey não abriu este cofre. Use a senha.',
    unavailable: 'Este navegador não consegue parear: ele não oferece WebRTC.',
    readOnly:
      'O relógio do dispositivo voltou, então o cofre está somente leitura: o pareamento volta quando a escrita voltar.',
    retired: 'Este dispositivo foi aposentado: ele não pode parear outro dispositivo.',
    corrupt:
      'Este dispositivo tem um registro que não consegue ler: parear o passaria adiante. Refunde o cofre ou restaure um backup.',
    sameNetwork: 'Somente na mesma rede (sem servidor STUN)',
    sameNetworkHint:
      'Os dois dispositivos precisam então estar na mesma rede. Sem isso, um servidor STUN ({hosts}) vê o endereço público deste dispositivo.',
    preparing: 'Preparando a conexão…',
    offerIntro:
      'Escaneie este código com o dispositivo novo, na tela de pareamento dele, ou copie o texto para ele. Depois escaneie ou cole a resposta dele abaixo.',
    offerLabel: 'Texto de pareamento deste dispositivo',
    qrLabel: 'Código deste dispositivo, para o outro dispositivo escanear',
    copy: 'Copiar',
    copied: 'Copiado',
    channel:
      'Quem vir este código, ou o que levar este texto, uma mensagem ou um e-mail, vê os endereços de rede deste dispositivo. Mais nada: os números comparados em seguida protegem o pareamento.',
    scan: 'Escanear com a câmera',
    scanStop: 'Parar a câmera',
    scanning: 'Aponte a câmera para o código que o outro dispositivo mostra.',
    noCamera: 'Este dispositivo não tem câmera: cole o texto.',
    cameraDenied: 'A câmera foi negada: permita nas configurações do navegador ou cole o texto.',
    cameraFailed: 'A câmera não iniciou: cole o texto.',
    readerFailed: 'O leitor de código não carregou: cole o texto.',
    leaving:
      'Sair do BlindVault para copiar ou colar conta como ocultá-lo: se ele ficar oculto por {seconds} segundos, o pareamento termina.',
    leavingImmediate:
      'Este cofre bloqueia assim que o BlindVault fica oculto, o que termina o pareamento: copie e cole sem sair do app, ou mude o bloqueio do app oculto abaixo.',
    answerPaste: 'Resposta do dispositivo novo',
    connect: 'Conectar',
    connecting: 'Conectando…',
    sasTitle: 'Compare os números',
    sasQuestion: 'O outro dispositivo mostra exatamente este número?',
    match: 'Sim, o mesmo',
    differ: 'Não, é diferente',
    waiting: 'Aguardando o outro dispositivo…',
    sending: 'Enviando o cofre…',
    done: '{name} está pareado: ele tem este cofre agora.',
    readmit:
      'Os outros dispositivos deste cofre ainda não conhecem este dispositivo nem {name}: readmita este dispositivo com um deles, para que possam sincronizar com os dois.',
    close: 'Concluir',
    again: 'Começar de novo',
    cancel: 'Cancelar',
    pasteInvalid: 'Isto não é um texto de pareamento do BlindVault. Copie-o de novo, inteiro.',
    pasteVersion: 'Este texto vem de outra versão do BlindVault: atualize os dois dispositivos.',
    pasteWrongSession: 'Esta resposta é de outro pareamento: cole a resposta ao texto acima.',
    pasteOutdated:
      'O dispositivo novo roda um BlindVault que não comporta este cofre: atualize o app nele e pareie de novo.',
    pastePeerHoldsVault:
      'Esse dispositivo já tem um cofre: para readmiti-lo, cancele aqui e escolha “Readmitir com outro dispositivo deste cofre…” nos dois dispositivos.',
    pastePeerNoVault:
      'Este texto vem de um dispositivo sem cofre: comece o pareamento no dispositivo que tem o cofre.',
    failed: {
      cancelled: 'O pareamento foi cancelado neste dispositivo.',
      cancelledRemote: 'O pareamento foi cancelado no outro dispositivo.',
      sasMismatch:
        'Os números são diferentes, então o pareamento parou e nada foi enviado. Alguém pode ter alterado os textos no caminho: pareie de novo e leve-os por outro meio.',
      locked:
        'Um cofre bloqueou, ou o BlindVault ficou oculto por tempo demais, então o pareamento parou.',
      expired: 'O pareamento demorou demais e expirou.',
      retiredPeer:
        'O dispositivo que tem o cofre foi aposentado, então nenhum dispositivo pode entrar por ele: pareie com outro dispositivo do cofre.',
      differentVaults: 'Os dois dispositivos têm cofres diferentes.',
      unsupportedFormat:
        'O cofre tem registros que este BlindVault não consegue ler: atualize o app no dispositivo novo e pareie de novo.',
      verificationFailed:
        'Um registro falhou na verificação, então o pareamento parou e o dispositivo novo não guardou nada.',
      version: 'Os dispositivos rodam versões do BlindVault que não pareiam: atualize os dois.',
      protocolError: 'O outro dispositivo enviou algo inesperado, então o pareamento parou.',
      closed: 'A conexão fechou, então o pareamento parou.',
    },
  },
  stun: {
    open: 'Servidores STUN…',
    intro:
      'A menos que somente a mesma rede seja escolhida, este dispositivo pede a esses servidores STUN o seu endereço público. Cada um vê esse endereço, e nada do cofre.',
    defaults: 'Estes são os padrões, Google e Cloudflare.',
    edit: 'Editar',
    label: 'Servidores STUN, um por linha, como stun:stun.example.org:3478',
    save: 'Salvar',
    cancel: 'Cancelar',
    reset: 'Restaurar os padrões',
    unreadable:
      'A lista de STUN guardada neste dispositivo não pode ser lida, então nenhum servidor STUN é usado e os dois dispositivos precisam estar na mesma rede: corrija a lista ou restaure os padrões.',
    notSaved: 'Este navegador não salvou a lista.',
    problems: {
      scheme:
        '“{url}” não é um servidor STUN: escreva stun:host ou stun:host:porta. TURN não é usado.',
      query: '“{url}”: nada depois de “?” é aceito.',
      host: '“{url}” não tem um nome de host ou endereço válido. Escreva um endereço IPv6 entre colchetes.',
      port: '“{url}” tem uma porta fora de 1 a 65535.',
      tooLong: '“{url}” tem mais de 255 caracteres.',
      empty: 'Informe pelo menos um servidor STUN, ou escolha somente a mesma rede.',
      tooMany: 'No máximo 8 servidores STUN.',
    },
  },
  join: {
    title: 'Parear com um dispositivo existente',
    intro:
      'Este dispositivo recebe o cofre de um dispositivo que o tem. Primeiro crie a senha local deste dispositivo; depois, no outro dispositivo, abra Configurações → Dispositivos → “Parear um dispositivo novo”.',
    submit: 'Continuar',
    scanIntro:
      'Escaneie o código que o outro dispositivo mostra, ou cole aqui o texto de pareamento dele.',
    offerPaste: 'Texto de pareamento do outro dispositivo',
    next: 'Continuar',
    answerIntro:
      'Mostre este código ao outro dispositivo, que o escaneia abaixo do dele, ou copie esta resposta de volta para ele.',
    answerLabel: 'Resposta deste dispositivo',
    waitingConnection: 'Aguardando o outro dispositivo conectar…',
    receiving: 'Recebendo o cofre…',
  },
  readmission: {
    title: 'Readmissão',
    intro:
      'Dois dispositivos deste cofre passam a se conhecer e mesclam tudo o que têm, nos dois sentidos: um dispositivo restaurado de um backup fica registrado, e dois dispositivos que nunca sincronizaram se encontram. Nenhuma chave sai de nenhum dos dois.',
    start: 'Readmitir com outro dispositivo deste cofre…',
    how: 'No outro dispositivo, abra também Configurações → Dispositivos → “Readmitir com outro dispositivo deste cofre…”. Um dispositivo mostra o texto dele primeiro; o outro o cola.',
    first: 'Mostrar primeiro o texto deste dispositivo',
    paste: 'Colar o texto do outro dispositivo',
    readOnly:
      'O relógio do dispositivo voltou, então o cofre está somente leitura: a readmissão volta quando a escrita voltar.',
    retired:
      'Este dispositivo foi aposentado: ele não pode ser readmitido. Substitua-o por pareamento para sincronizar.',
    corrupt:
      'Este dispositivo tem um registro que não consegue ler: a readmissão o passaria adiante. Refunde o cofre ou restaure um backup.',
    offerIntro:
      'Escaneie este código com o outro dispositivo, na tela de readmissão dele, ou copie o texto para ele. Depois escaneie ou cole a resposta dele abaixo.',
    answerPaste: 'Resposta do outro dispositivo',
    scanIntro:
      'Escaneie o código que o outro dispositivo mostra, ou cole aqui o texto de readmissão dele.',
    offerPaste: 'Texto de readmissão do outro dispositivo',
    answerIntro:
      'Mostre este código ao outro dispositivo, que o escaneia abaixo do dele, ou copie esta resposta de volta para ele.',
    merging: 'Mesclando os dois dispositivos…',
    done: 'Readmitido com {name}: os dois dispositivos se conhecem e têm os mesmos registros.',
    notCommitted:
      'Este dispositivo mesclou, mas o outro pode não ter terminado: confira nele. Readmitir de novo é seguro.',
    rejected:
      '{n} registros do outro dispositivo foram rejeitados e não mesclados: {records}. O resto foi mesclado.',
    rejectedNoKey: 'um registro que não decodifica',
    rejectedReasons: {
      'verification-failed': 'não verifica',
      'future-clock': 'datado à frente do relógio deste dispositivo',
      'immutable-record': 'uma cópia alterada de um registro que nunca muda',
    },
    pastePeerNoVault:
      'Este texto vem de um dispositivo sem cofre: pareie-o em vez disso, com “Parear um dispositivo novo…”.',
    failed: {
      cancelled: 'A readmissão foi cancelada neste dispositivo.',
      cancelledRemote: 'A readmissão foi cancelada no outro dispositivo.',
      sasMismatch:
        'Os números são diferentes, então a readmissão parou e nada foi enviado. Alguém pode ter alterado os textos no caminho: comece de novo e leve-os por outro meio.',
      locked:
        'Um cofre bloqueou, ou o BlindVault ficou oculto por tempo demais, então a readmissão parou.',
      expired: 'A readmissão demorou demais e expirou.',
      retiredPeer:
        'Um dos dois dispositivos foi aposentado, então a readmissão parou: readmita com outro dispositivo do cofre.',
      differentVaults:
        'Os dois dispositivos têm cofres diferentes, e nada foi escrito. Para que um deles tenha este cofre, bloqueie-o e escolha “Substituir por pareamento com outro dispositivo…” na tela de desbloqueio dele.',
      unsupportedFormat:
        'O outro dispositivo tem registros que este BlindVault não consegue ler: atualize o app neste dispositivo e readmita de novo.',
      unsupportedFormatRemote:
        'Este dispositivo tem registros que o BlindVault do outro dispositivo não consegue ler: atualize o app nele e readmita de novo.',
      verificationFailed:
        'Um registro guardado falhou na verificação, então a readmissão parou antes da mescla.',
      version: 'Os dispositivos rodam versões do BlindVault que não readmitem: atualize os dois.',
      protocolError: 'O outro dispositivo enviou algo inesperado, então a readmissão parou.',
      closed: 'A conexão fechou, então a readmissão parou.',
    },
  },
  sync: {
    start: 'Sincronizar',
    title: 'Sincronizar com {name}',
    notifyTitle: 'Avisar {name} que foi aposentado',
    notifyHow:
      'Em {name}, abra Configurações → Dispositivos e escolha “Sincronizar” ao lado deste dispositivo. Este dispositivo envia a {name} só o registro aposentado dele, e a sincronização termina: {name} então mostra que foi aposentado e para de sincronizar.',
    how: 'Em {name}, abra também Configurações → Dispositivos e escolha “Sincronizar” ao lado deste dispositivo. Um dispositivo mostra o código dele primeiro; o outro o escaneia ou cola.',
    first: 'Mostrar primeiro o código deste dispositivo',
    read: 'Ler o código de {name}',
    cancel: 'Cancelar',
    unavailable: 'Este navegador não consegue sincronizar: ele não oferece WebRTC.',
    refused: {
      unregistered:
        'Este dispositivo ainda não tem o próprio registro de dispositivo: readmita-o antes com outro dispositivo deste cofre.',
      retired:
        'Este dispositivo foi aposentado: ele não pode sincronizar. Substitua-o por pareamento.',
      'unknown-peer':
        'Este dispositivo não conhece {name}: sincronize antes com o dispositivo que o pareou.',
      'retired-peer': '{name} foi aposentado: ele não pode sincronizar.',
      'not-retired': '{name} não está aposentado.',
    },
    offerIntro:
      'Escaneie este código com {name}, na tela de sincronização dele, ou copie o texto para ele. Depois escaneie ou cole a resposta dele abaixo.',
    offerLabel: 'Texto de sincronização deste dispositivo',
    answerPaste: 'Resposta de {name}',
    connect: 'Conectar',
    scanIntro: 'Escaneie o código que {name} mostra, ou cole aqui o texto de sincronização dele.',
    offerPaste: 'Texto de sincronização de {name}',
    next: 'Avançar',
    answerIntro:
      'Mostre este código a {name}, que o escaneia abaixo do dele, ou copie esta resposta de volta para ele.',
    answerLabel: 'Resposta deste dispositivo',
    channel:
      'Este código é cifrado para {name}: quem o vê, ou o que leva o texto, só fica sabendo que um código foi enviado.',
    waiting: 'Esperando a conexão…',
    preparing: 'Preparando a conexão…',
    connecting: 'Conectando…',
    connected:
      'Conectado a {name}, com a identidade verificada. A troca de registros vem numa versão futura: feche a sincronização aqui.',
    close: 'Fechar',
    again: 'Começar de novo',
    leaving:
      'Sair do BlindVault para copiar ou colar conta como ocultá-lo: se ele ficar oculto por {seconds} segundos, a sincronização termina.',
    leavingImmediate:
      'Este cofre bloqueia assim que o BlindVault fica oculto, o que encerra a sincronização: copie e cole sem sair do app, ou mude o bloqueio do app oculto abaixo.',
    paste: {
      malformed:
        'Este não é um texto de sincronização do BlindVault inteiro. Copie-o de novo, inteiro.',
      version: 'Este texto vem de outra versão do BlindVault: atualize os dois dispositivos.',
      'not-from-peer':
        'Este código não é de {name} para este dispositivo: confira se cada dispositivo escolheu o outro.',
    },
    failed: {
      expired: 'A sincronização demorou demais e expirou.',
      closed: 'A conexão fechou, então a sincronização parou.',
      error: 'Não foi possível montar a conexão, então a sincronização parou.',
      unverified:
        'Este dispositivo não conseguiu verificar {name}, então a sincronização parou. Gere um novo código nos dois dispositivos.',
      ended: '{name} encerrou a sincronização.',
      locked: '{name} bloqueou o cofre, então a sincronização parou.',
      version:
        '{name} usa outra versão do BlindVault, então a sincronização parou: atualize os dois dispositivos.',
      'protocol-error':
        '{name} enviou algo que este dispositivo não espera, então a sincronização parou. Atualize os dois dispositivos e tente de novo.',
      'retired-peer':
        '{name} está aposentado: este dispositivo o avisou e não enviou mais nada, e a sincronização terminou.',
      retired:
        '{name} tem este dispositivo como aposentado, então a sincronização terminou. Este dispositivo não pode mais sincronizar.',
      'verification-failed':
        'O registro de {name} neste dispositivo falhou na verificação, então nada foi enviado e a sincronização parou.',
    },
  },
  ready: {
    title: 'Cofre pronto',
    intro: 'Seu cofre está neste dispositivo. Antes de começar:',
    passkey: 'Desbloqueie com uma passkey em vez de digitar a senha local.',
    passkeyAction: 'Configurar uma passkey',
    checkPhrase:
      'Este cofre foi restaurado com uma senha de exportação: verifique se sua Frase de Recuperação ainda o abre.',
    checkPhraseAction: 'Verificar a Frase de Recuperação',
    readmitAction: 'Ver os dispositivos',
    pair: 'Pareie outro dispositivo, para que o cofre tenha uma segunda cópia que fica sincronizada.',
    pairAction: 'Parear um dispositivo',
    backup:
      'Faça um backup e guarde-o fora deste dispositivo: com a Frase de Recuperação, ele traz o cofre de volta se este dispositivo for perdido.',
    backupAction: 'Fazer um backup',
    open: 'Abrir o cofre',
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
    pairChoose: 'Substituir por pareamento com outro dispositivo…',
    pairTitle: 'Substituir este cofre por pareamento',
    pairWarning:
      'O cofre deste dispositivo é apagado e substituído pelo cofre do dispositivo com que você parear, seja ele este cofre ou outro. As mudanças que só existem neste dispositivo se perdem. Se você ainda consegue desbloquear o cofre, faça um backup antes, em Configurações.',
    understand: 'Entendo que o cofre deste dispositivo será substituído',
    submit: 'Substituir',
    replacing: 'Substituindo o cofre…',
    leftoverPasskey:
      'A passkey do cofre substituído não desbloqueia mais nada: apague no seu gerenciador de passkeys a passkey "BlindVault" que você não usa mais.',
  },
  erase: {
    choose: 'Apagar este cofre deste dispositivo…',
    title: 'Apagar este cofre deste dispositivo',
    intro:
      'Remove o cofre e as configurações locais dele só deste dispositivo. Os outros dispositivos e os backups mantêm a cópia deles.',
    warning:
      'As mudanças que só existem neste dispositivo se perdem. Faça um backup antes, se você ainda consegue desbloquear o cofre.',
    onlyDevice: 'Este é o único dispositivo com o cofre: sem um backup, ele se perde de vez.',
    named:
      'Depois, aposente o registro de dispositivo deste dispositivo, "{name}", a partir de outro dispositivo: até lá, eles continuam a oferecê-lo para sincronizar.',
    locked:
      'Depois, aposente o registro de dispositivo deste dispositivo a partir de outro dispositivo: até lá, eles continuam a oferecê-lo para sincronizar. O nome dele não pode ser mostrado com o cofre bloqueado.',
    unregistered: 'Este dispositivo não tem registro de dispositivo a aposentar.',
    understand: 'Entendo que o cofre deste dispositivo será apagado',
    submit: 'Apagar',
    cancel: 'Cancelar',
    erasing: 'Apagando o cofre…',
    backupNow: 'Fazer um backup agora',
    busy: 'O BlindVault está ocupado em outra janela. Nada foi apagado.',
    failed: 'Não foi possível apagar o cofre. Ele continua neste dispositivo, bloqueado.',
    done: 'O cofre foi apagado deste dispositivo.',
    leftoverPasskey:
      'A passkey do cofre apagado não desbloqueia mais nada: apague no seu gerenciador de passkeys a passkey "BlindVault" que você não usa mais.',
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
    clockBehind:
      'O relógio deste dispositivo voltou, então o cofre está somente leitura até {date}. A sincronização continua recebendo registros.',
    clockFar:
      'As alterações feitas com o relógio errado existem só neste dispositivo, porque os seus outros dispositivos as rejeitaram, e continuam legíveis para você copiá-las à mão. Para escrever antes disso, refunde o cofre.',
    clockPairAgain:
      'Ou pareie este dispositivo de novo a partir de outro: bloqueie e escolha “Substituir por pareamento com outro dispositivo…”.',
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
    devicesLastSync: 'Última sincronização com este dispositivo: {date}',
    devicesNeverSynced: 'Última sincronização com este dispositivo: nunca',
    devicesPending:
      'Pareamento não concluído: este dispositivo nunca recebeu a confirmação de que o outro guardou o cofre.',
    devicesPendingRetire:
      'Antes de aposentar {name}, olhe para ele: se ele mostra o cofre, o pareamento deu certo e só a confirmação se perdeu.',
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
    devicesRetiredList: 'Dispositivos aposentados',
    devicesRetiredNotify:
      'Um dispositivo aposentado só fica sabendo quando é avisado: sincronize com ele daqui, e ele recebe só o registro aposentado dele.',
    devicesNotify: 'Avisar {name}',
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
