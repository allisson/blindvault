# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Extracts the official Noise test vectors that docs/crypto-spec.md §15 requires (D157, D200).

Downloads the cacophony and snow vector files at pinned commits, checks their SHA-256, and writes
the vectors of Noise_XX, Noise_KK and Noise_K in 25519_ChaChaPoly_BLAKE2b, unchanged, to
packages/crypto/test-vectors/noise-v1.json. The output is deterministic.

Run from the repository root: uv run tests/vectors/noise.py
"""

import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages/crypto/test-vectors/noise-v1.json"

PROTOCOLS = [
    "Noise_XX_25519_ChaChaPoly_BLAKE2b",
    "Noise_KK_25519_ChaChaPoly_BLAKE2b",
    "Noise_K_25519_ChaChaPoly_BLAKE2b",
]

SOURCES = [
    {
        "name": "cacophony",
        "url": "https://raw.githubusercontent.com/haskell-cryptography/cacophony/"
        "8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/vectors/cacophony.txt",
        "license": "Unlicense (public domain)",
        "sha256": "3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae",
    },
    {
        "name": "snow",
        "url": "https://raw.githubusercontent.com/mcginty/snow/"
        "8ac60f51cfe3e010c84f0a454cc575ad9204fa12/tests/vectors/snow.txt",
        "license": "Apache-2.0, Copyright (c) Jake McGinty",
        "sha256": "69da433305fd045f6c9f01b656662a389d022688986fd39fbe7af009cd402fd3",
    },
]

# Fields a vector of these protocols may carry; anything else (a PSK, a fallback) is refused.
FIELDS = {
    "protocol_name", "init_prologue", "init_static", "init_ephemeral", "init_remote_static",
    "resp_prologue", "resp_static", "resp_ephemeral", "resp_remote_static", "handshake_hash",
    "messages", "init_psks", "resp_psks",
}


def main() -> None:
    sources, vectors = [], []
    for source in SOURCES:
        with urllib.request.urlopen(source["url"]) as response:
            data = response.read()
        digest = hashlib.sha256(data).hexdigest()
        if digest != source["sha256"]:
            raise SystemExit(f"{source['name']}: SHA-256 {digest}, expected {source['sha256']}")
        found = [v for v in json.loads(data)["vectors"] if v.get("protocol_name") in PROTOCOLS]
        for name in PROTOCOLS:
            if not any(v["protocol_name"] == name for v in found):
                raise SystemExit(f"{source['name']}: no vector for {name}")
        for v in found:
            if set(v) - FIELDS or v.get("init_psks") or v.get("resp_psks"):
                raise SystemExit(f"{source['name']}: unexpected fields in {v['protocol_name']}")
            v = {k: v[k] for k in v if k not in ("init_psks", "resp_psks")}
            vectors.append({"source": source["name"], **v})
        sources.append(source)
    OUT.write_text(json.dumps({"sources": sources, "vectors": vectors}, indent=2) + "\n")


if __name__ == "__main__":
    main()
