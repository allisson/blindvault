# Frozen backups

Each `<build>.bvault` here was exported by the app of that published build, never by the current
code, and is never regenerated (`backup-format.md` §9, D310). Beside it, `<build>.json` holds its
Recovery Phrase, its export password and the summary of the vault it restores to.
`tests/frozen-backups.test.ts` restores every file with the phrase and with the password, and
compares the result with the summary.

To add one, at a release that changes the format or the content of a record:

1. In the published app, create a vault with fictitious data only: every template, a nested
   folder, an item in the trash, an item with history, a tombstone, an ES256 and an EdDSA passkey
   (through the extension), and an attachment of more than 64 KiB.
2. Export it with an export password, and save it here as `<build>.bvault`.
3. Write `<build>.json` with `build`, `phrase` and `exportPassword`, and run
   `pnpm --filter @blindvault/tests exec vitest run frozen-backups`: the failure prints the summary
   the file restores to. Check it against what you entered, then add it as `summary`.

Never edit or replace a file once committed.
