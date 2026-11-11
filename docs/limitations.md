# BlindVault — Limitations

What BlindVault cannot do for you, in plain words. Read this before you trust it with anything you
cannot afford to lose or expose. It states the limits the overview requires user documentation to
state (overview §3, §5.4, §7, §14, §17, §20); the overview prevails over it.

Until 1.0, every release is a pre-release: treat its vaults as throwaway (D177).

## Nobody can recover your vault for you

BlindVault has no account, no data server and no administrator recovery, hidden or otherwise. Your
vault exists only on your devices and in the `.bvault` backups you make. **If you lose every device,
every backup and your Recovery Phrase, the vault is lost for good.** Nobody, including the project,
can open it.

| If you… | Then |
| --- | --- |
| Forget the local password of a device | Set a new one with your Recovery Phrase from that device's unlock screen |
| Lose a device | Pair a new one, or restore a backup, then retire the lost device from another one |
| Lose every device | Restore a backup with its Recovery Phrase |
| Lose your Recovery Phrase | Make a new one while the vault is unlocked, then make a new backup |

Browser storage is not permanent. A browser can delete a site's data when the disk fills up or when
you clear it, and Safari deletes the data of a site you have not interacted with during seven days
of Safari use, unless the app is installed (Home Screen on iOS, Dock on macOS). Keep a recent backup and a second
device. The vault also belongs to the web address that serves the app: moving to another address
(a new domain, or hosting it yourself) leaves the vault behind, so make a backup and restore it
there, or pair a device there.

## Memory is not guaranteed to be wiped

Locking removes the decrypted items from the app, releases its keys, clears its caches and stops
every operation in progress. JavaScript, however, gives no way to make sure the memory that held
them is overwritten: copies made by the JavaScript engine, the browser or the operating system
(swap, crash reports, hibernation files) can remain until that memory is reused. Someone who can
read the memory of your device, through malware or forensic tools, may recover data from a session
that was unlocked recently. Auto-lock and the lock when the app is hidden limit how long the vault
stays unlocked; they do not erase memory.

Copying a secret puts it in the system clipboard. The app tries to clear it after 30 seconds, but it
cannot guarantee that, and clipboard history or a clipboard synced to the cloud are outside its
control.

## Devices cannot be revoked

Every device of a vault holds its Master Key, and BlindVault never changes that key. Retiring a
device makes the other devices refuse to sync with it once they know of the retirement, but it
cannot erase anything that device, or a backup it made, already holds. **No copy of your vault can
be erased remotely**: not a retired device, not a lost one, not a backup, not a copy of a device's
storage.

Treat your Master Key as compromised when a device was lost unlocked or with a weak local password
or a weak passkey lock, when your Recovery Phrase or the export password of a backup was exposed, or
when the app shows a retirement or a new device you did not expect. The response is to re-found the
vault: it keeps your current items under entirely new keys, and you then pair your other devices
again and destroy your old backups. Re-founding protects only what happens afterwards: anyone who
already copied the old vault keeps it.

## Old backups and the old Recovery Phrase

A backup always opens with the Recovery Phrase that was current when it was made. Making a new phrase
does not change backups that already exist: they still open with the old phrase, and a device that
has not synced since keeps making backups for the old phrase until it does. Each backup shows the
date of the phrase it opens with, so keep each phrase as long as you keep a backup that needs it.

A new phrase is for a lost phrase, not an exposed one. Whoever holds an old phrase can open every
backup made for it and any copy of a device's storage that has not received the new phrase, and so
obtain the Master Key, which a new phrase does not change. If a phrase was exposed, re-found the
vault.

A backup can also open with an export password. Whoever opens it that way holds the Master Key for
good, so a weak or exposed export password is as serious as an exposed phrase. Changing your
password later does not change the backups you already made.

## The app you run must be trusted

Encryption protects the vault while it is locked. It cannot protect an unlocked vault from the code
that runs it: a modified app, a malicious browser extension, a compromised browser or operating
system can read everything once you unlock.

- **Trust on first use.** The first time you open BlindVault, nothing can check the code the host
  sends you.
- **Updates.** A new version is shown with its version number and hash, and is applied only after
  you confirm it; applying it locks the vault.
- **The host can still replace the app.** The browser itself fetches the app's service worker, so a
  host can serve a different one. BlindVault detects that, locks the vault and warns you, but it
  cannot prevent it. If you see that warning, do not unlock again until you have checked the
  release outside the app.
- **The hash in About is informational.** A modified app can display any hash. The decisive check
  happens outside the app: rebuild from source and compare ([build.md](build.md)), or compare the
  files the host serves with the GitHub Release. You can also serve BlindVault yourself
  ([self-hosting.md](self-hosting.md)).

## What BlindVault does not defend against

- a compromised operating system, malware that reads the browser's memory, and keyloggers;
- malicious browser extensions, and a malicious browser;
- someone holding your device while the vault is unlocked;
- a modified app run before you verified it, the first load included.

It also has these limits:

- **A weak local password.** On a lost device, the local password is what stands between a thief
  and the vault. Argon2id makes each guess slow; it does not make a weak password safe. A password
  saved by the browser is as safe as the browser's own password storage.
- **A synced passkey.** A passkey synced by iCloud Keychain or Google Password Manager can unlock
  the vault for whoever controls that account and gets a copy of the device's storage.
- **A cloned installation.** Copying a browser profile or a virtual machine and running both copies
  gives two installations one device identity, whose changes may never agree. Erase the copy and
  pair it again. Restoring an older copy of a device's storage cannot be detected either; your other
  devices bring the newer data back at the next sync.
- **Visible metadata.** Someone who reads the storage of a locked device sees the number and kinds
  of records, when each change was made and by which device, and the approximate size of each
  record, but no content. A backup shows the date and identifier of its Recovery Phrase, whether it
  has an export password, and its approximate size.
