# blindvault

A local-first, end-to-end encrypted personal vault that runs in the browser. Official build: https://blindvault.allisson.dev. To serve it yourself, see [docs/self-hosting.md](docs/self-hosting.md).
BlindVault is not yet at v1.0 and has had no independent security review.

## Design and review

The design is written down before the code, and review of it is welcome. Start with the overview,
which prevails over every other document:

- [docs/overview.md](docs/overview.md): architecture, cryptography, protocols, invariants and the
  decision log (section 21).
- [docs/threat-model.md](docs/threat-model.md): what BlindVault defends against, and what it does not.
- [docs/crypto-spec.md](docs/crypto-spec.md): primitives, key hierarchy, AAD and record encryption.
- [docs/pairing-protocol.md](docs/pairing-protocol.md): pairing two devices over WebRTC with Noise
  and a SAS.
- [docs/sync-protocol.md](docs/sync-protocol.md): reconnection and sync between paired devices.
- [docs/backup-format.md](docs/backup-format.md): the encrypted `.bvault` backup file.
- [docs/record-content.md](docs/record-content.md): what an encrypted record holds.
- [docs/security-invariants.md](docs/security-invariants.md): each invariant and the tests that
  cover it.
- [docs/build.md](docs/build.md): the reproducible build and the asset manifest.
- [GLOSSARY.md](GLOSSARY.md): the domain terms.

Send design findings and questions as GitHub issues. Report a vulnerability privately, as
[SECURITY.md](SECURITY.md) explains.
