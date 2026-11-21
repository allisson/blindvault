# Public Suffix List (D283)

`public_suffix_list.dat` and `test_psl.txt` are copied unchanged from
[`publicsuffix/list`](https://github.com/publicsuffix/list) at one commit, so filling and the
passkey `rpId` check never fetch the list at run time (`docs/extension.md` §5.5).

| | |
| --- | --- |
| Commit | `87a2c1b8de5886a133ff4da21b2aa6fec88d8739` (2026-11-21) |
| `public_suffix_list.dat` | SHA-256 `00a0af2ed2379634523b9ca80de3469d1466893915c252a91264e248c92d69d8` |
| `tests/test_psl.txt` | SHA-256 `8f50ad958916d6a8f79fba2363501475571acce752757f9126fe9d2f17dd920d` |

Updating it is a reviewed change: take both files from one newer commit, update this table and run
`pnpm --filter @blindvault/vault exec vitest run src/psl src/match`.

```sh
C=<commit>
curl -fsSL -o public_suffix_list.dat https://raw.githubusercontent.com/publicsuffix/list/$C/public_suffix_list.dat
curl -fsSL -o test_psl.txt https://raw.githubusercontent.com/publicsuffix/list/$C/tests/test_psl.txt
shasum -a 256 public_suffix_list.dat test_psl.txt
```
