# /// script
# requires-python = ">=3.12"
# dependencies = ["pynacl==1.6.2", "mnemonic==0.21"]
# ///
"""Independent generator for docs/crypto-spec.md test vectors (record format v1).

Uses hashlib (BLAKE2b, crypto_kdf) and PyNaCl (AEAD, Argon2id, seed key pair, padding), never the
TypeScript code, so the TypeScript implementation is checked against a second implementation.
Inputs are fixed bytes, so the output is deterministic.

Run from the repository root: uv run tests/vectors/generate.py
"""

import hashlib
import json
import math
import struct
import unicodedata
from pathlib import Path

from mnemonic import Mnemonic
from nacl import bindings, pwhash

OUT = Path(__file__).resolve().parents[2] / "packages/crypto/test-vectors/crypto-v1.json"

RECORD_FORMAT_VERSION = 1
RT_ITEM, RT_FOLDER, RT_ITEM_VERSION, RT_VAULT_KEY, RT_RECOVERY_ENVELOPE, RT_DEVICE = 1, 2, 3, 4, 5, 6
PAD_BLOCK = 256
RECORD_CAP = 1024 * 1024
MAX_CT = RECORD_CAP + PAD_BLOCK + 16
ITEM_CAP = RECORD_CAP - 66


def h(b: bytes) -> str:
    return b.hex()


def seq(start: int, n: int) -> bytes:
    return bytes((start + i) & 0xFF for i in range(n))


# --- section 3: layout -----------------------------------------------------------------------


def field(x: bytes) -> bytes:
    return struct.pack(">I", len(x)) + x


def layout(*xs: bytes) -> bytes:
    return b"".join(field(x) for x in xs)


def u8(n: int) -> bytes:
    return struct.pack(">B", n)


def u16(n: int) -> bytes:
    return struct.pack(">H", n)


def u32(n: int) -> bytes:
    return struct.pack(">I", n)


def u64(n: int) -> bytes:
    return struct.pack(">Q", n)


def label(s: str) -> bytes:
    return s.encode("ascii")


# --- section 2/5: BLAKE2b and crypto_kdf ------------------------------------------------------


def blake2b(data: bytes, n: int, key: bytes = b"") -> bytes:
    return hashlib.blake2b(data, digest_size=n, key=key).digest()


def kdf(key: bytes, subkey_id: int, ctx: str) -> bytes:
    c = ctx.encode("ascii")
    assert len(c) == 8 and len(key) == 32
    salt = struct.pack("<Q", subkey_id) + bytes(8)
    person = c + bytes(8)
    return hashlib.blake2b(b"", digest_size=32, key=key, salt=salt, person=person).digest()


# --- section 7: AEAD ---------------------------------------------------------------------------


def seal(key: bytes, aad: bytes, pt: bytes, nonce: bytes) -> dict:
    assert len(nonce) == 24
    c = bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(pt, aad, nonce, key)
    return {"n": nonce, "c": c}


def opens(key: bytes, aad: bytes, sealed: dict) -> bool:
    try:
        bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(sealed["c"], aad, sealed["n"], key)
        return True
    except Exception:
        return False


# --- section 14: minimal RFC 8949 §4.2 deterministic CBOR encoder (uint, bytes, text, array, map, bool)


def _head(major: int, n: int) -> bytes:
    if n < 24:
        return bytes([major << 5 | n])
    if n < 0x100:
        return bytes([major << 5 | 24, n])
    if n < 0x10000:
        return bytes([major << 5 | 25]) + struct.pack(">H", n)
    if n < 0x100000000:
        return bytes([major << 5 | 26]) + struct.pack(">I", n)
    return bytes([major << 5 | 27]) + struct.pack(">Q", n)


def cbor(v) -> bytes:
    if v is True:
        return b"\xf5"
    if v is False:
        return b"\xf4"
    if v is None:
        return b"\xf6"
    if isinstance(v, int):
        return _head(0, v) if v >= 0 else _head(1, -1 - v)
    if isinstance(v, float):
        if math.isnan(v):
            return b"\xf9\x7e\x00"
        for fmt, ib in ((">e", 0xF9), (">f", 0xFA)):
            try:
                packed = struct.pack(fmt, v)
            except (OverflowError, struct.error):
                continue
            if struct.unpack(fmt, packed)[0] == v:
                return bytes([ib]) + packed
        return b"\xfb" + struct.pack(">d", v)
    if isinstance(v, (bytes, bytearray)):
        return _head(2, len(v)) + bytes(v)
    if isinstance(v, str):
        b = v.encode("utf-8")
        return _head(3, len(b)) + b
    if isinstance(v, list):
        return _head(4, len(v)) + b"".join(cbor(x) for x in v)
    if isinstance(v, dict):
        items = sorted((cbor(k), cbor(x)) for k, x in v.items())
        keys = [k for k, _ in items]
        assert len(set(keys)) == len(keys)
        return _head(5, len(v)) + b"".join(k + x for k, x in items)
    raise TypeError(type(v))


def _max_envelope_length() -> int:
    """Largest valid v1 envelope: a Recovery Envelope (the type with the most parts) with every
    header field at its maximum and ct.c at the ciphertext cap."""
    sealed = lambda n: {"n": bytes(24), "c": bytes(n)}  # noqa: E731
    env = {"v": RECORD_FORMAT_VERSION, "t": RT_RECOVERY_ENVELOPE, "id": bytes(16), "e": 2**32 - 1,
           "hlc": [2**53 - 1, 2**32 - 1, bytes(16)], "del": False,
           "wk": sealed(48), "mk": sealed(48), "ct": sealed(MAX_CT)}
    return len(cbor(env))


def pad(b: bytes) -> bytes:
    return bindings.sodium_pad(b, PAD_BLOCK)


def normalize_password(pw: str) -> bytes:
    """crypto-spec section 6: Zs -> U+0020, NFC, reject Cc and empty or White_Space-only, UTF-8."""
    mapped = "".join(" " if unicodedata.category(ch) == "Zs" else ch for ch in pw)
    nfc = unicodedata.normalize("NFC", mapped)
    if any(unicodedata.category(ch) == "Cc" for ch in nfc) or all(ch.isspace() for ch in nfc):
        raise ValueError("rejected password")
    return nfc.encode("utf-8")


# --- fixed inputs ------------------------------------------------------------------------------

MASTER_KEY = seq(0x00, 32)
VAULT_KEY = seq(0x20, 32)
RECORD_KEY = seq(0x40, 32)
PHRASE_ENTROPY = seq(0x60, 32)
PRF_OUTPUT = seq(0x80, 32)
VAULT_ID = seq(0xA0, 16)
LOCAL_CONFIG_ID = seq(0xB0, 16)
ITEM_ID = seq(0xC0, 16)
STATIC_SK = seq(0xD0, 32)
STATIC_PK = bindings.crypto_scalarmult_base(STATIC_SK)
DEVICE_ID = blake2b(STATIC_PK, 16)
PHRASE_ID = seq(0xE0, 16)
KEY_EPOCH = 1
HLC = (1_760_000_000_000, 7, DEVICE_ID)


def nonce(i: int) -> bytes:
    return bytes([i]) * 24


def record_key(i: int) -> bytes:
    return blake2b(b"record key " + bytes([i]), 32)


def record_aad(rtype, record_id, epoch, hlc, deleted, version=RECORD_FORMAT_VERSION, vault_id=VAULT_ID):
    ms, ctr, dev = hlc
    return layout(u16(version), u16(rtype), vault_id, record_id, u32(epoch), u64(ms), u32(ctr), dev, u8(1 if deleted else 0))


def local_aad(purpose: str) -> bytes:
    return layout(label(purpose), VAULT_ID, LOCAL_CONFIG_ID)


def sealed_cbor(s: dict) -> dict:
    return {"n": s["n"], "c": s["c"]}


def envelope(rtype, record_id, epoch, hlc, deleted, **parts) -> dict:
    env = {"v": RECORD_FORMAT_VERSION, "t": rtype, "id": record_id, "e": epoch, "hlc": list(hlc), "del": deleted}
    env.update(parts)
    return env


MAX_ENVELOPE = _max_envelope_length()


# --- reference verifier for crypto-spec §9.5, used only to check the vectors ---------------------


class Reject(Exception):
    def __init__(self, step: int, why: str):
        super().__init__(f"step {step}: {why}")
        self.step = step


def _decode(b: bytes, i: int = 0):
    if i >= len(b):
        raise ValueError("truncated")
    ib = b[i]; major, info = ib >> 5, ib & 31
    if ib in (0xF4, 0xF5):
        return ib == 0xF5, i + 1
    if ib == 0xF6:
        return None, i + 1
    if ib in (0xF9, 0xFA, 0xFB):
        fmt, size = {0xF9: (">e", 2), 0xFA: (">f", 4), 0xFB: (">d", 8)}[ib]
        if i + 1 + size > len(b):
            raise ValueError("truncated")
        return struct.unpack(fmt, b[i + 1:i + 1 + size])[0], i + 1 + size
    if major == 7:
        raise ValueError("simple value or undefined")
    if info < 24:
        n, j = info, i + 1
    elif info in (24, 25, 26, 27):
        size = 1 << (info - 24); n = int.from_bytes(b[i + 1:i + 1 + size], "big"); j = i + 1 + size
        if j > len(b):
            raise ValueError("truncated")
    else:
        raise ValueError("indefinite length or unsupported")
    if major == 0:
        return n, j
    if major == 1:
        return -1 - n, j
    if major in (2, 3):
        if j + n > len(b):
            raise ValueError("truncated")
        raw = b[j:j + n]
        return (raw if major == 2 else raw.decode("utf-8")), j + n
    if major == 4:
        out = []
        for _ in range(n):
            x, j = _decode(b, j); out.append(x)
        return out, j
    if major == 5:
        out = {}
        for _ in range(n):
            k, j = _decode(b, j); x, j = _decode(b, j)
            if k in out:
                raise ValueError("duplicate key")
            out[k] = x
        return out, j
    raise ValueError("unsupported major type")


def strict_decode(b: bytes):
    x, j = _decode(b)
    if j != len(b) or cbor(x) != b:
        raise ValueError("non-canonical or trailing bytes")
    return x


ENVELOPE_KEYS = {
    RT_ITEM: {"wk", "ct"}, RT_FOLDER: {"wk", "ct"}, RT_ITEM_VERSION: {"wk", "ct"},
    RT_VAULT_KEY: {"ct"}, RT_RECOVERY_ENVELOPE: {"wk", "ct", "mk"}, RT_DEVICE: {"wk", "ct"},
}
NEVER_DELETED = {RT_VAULT_KEY, RT_RECOVERY_ENVELOPE, RT_DEVICE, RT_ITEM_VERSION}


def verify(data: bytes, vault_id: bytes, vault_keys: dict, k_vkwrap: bytes, k_version: bytes):
    """Returns the decoded content (or None for a purged tombstone); raises Reject(step)."""
    if len(data) > MAX_ENVELOPE:
        raise Reject(1, "envelope too long")
    try:
        env = strict_decode(data)
    except (ValueError, UnicodeDecodeError) as e:
        raise Reject(2, str(e))
    if not isinstance(env, dict) or any(not isinstance(k, str) for k in env):
        raise Reject(3, "not a text-keyed map")
    t = env.get("t")
    if env.get("v") != RECORD_FORMAT_VERSION or t not in ENVELOPE_KEYS:
        raise Reject(3, "unknown version or type")
    if set(env) != {"v", "t", "id", "e", "hlc", "del"} | ENVELOPE_KEYS[t]:
        raise Reject(3, "envelope keys")
    e, hlc = env["e"], env["hlc"]
    if not (isinstance(env["id"], bytes) and len(env["id"]) == 16):
        raise Reject(3, "id")
    if not (isinstance(e, int) and not isinstance(e, bool) and 1 <= e <= 2**32 - 1):
        raise Reject(3, "keyEpoch")
    if not (isinstance(hlc, list) and len(hlc) == 3 and isinstance(hlc[0], int) and not isinstance(hlc[0], bool)
            and hlc[0] <= 2**53 - 1 and isinstance(hlc[1], int) and not isinstance(hlc[1], bool)
            and hlc[1] <= 2**32 - 1 and isinstance(hlc[2], bytes) and len(hlc[2]) == 16):
        raise Reject(3, "hlc")
    if not isinstance(env["del"], bool):
        raise Reject(3, "del")
    for part in ENVELOPE_KEYS[t]:
        s_ = env[part]
        if not (isinstance(s_, dict) and set(s_) == {"n", "c"} and isinstance(s_["n"], bytes) and len(s_["n"]) == 24
                and isinstance(s_["c"], bytes)):
            raise Reject(3, f"{part} shape")
        if part in ("wk", "mk") and len(s_["c"]) != 48:
            raise Reject(3, f"{part} length")
    if env["del"] and t in NEVER_DELETED:
        raise Reject(4, "type never deleted")
    c = env["ct"]["c"]
    if t == RT_VAULT_KEY:
        if len(c) != 48:
            raise Reject(5, "Vault Key ct length")
    elif len(c) > MAX_CT or not (len(c) == 16 or (len(c) >= 16 + PAD_BLOCK and (len(c) - 16) % PAD_BLOCK == 0)):
        raise Reject(5, "ct length")
    aad = record_aad(t, env["id"], e, tuple(hlc), env["del"], vault_id=vault_id)
    try:
        if t == RT_VAULT_KEY:
            pt = bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(c, aad, env["ct"]["n"], k_vkwrap)
        else:
            if e not in vault_keys:
                raise Reject(7, "Vault Key of epoch not held")
            rk = bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(env["wk"]["c"], aad, env["wk"]["n"], vault_keys[e])
            pt = bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(c, aad, env["ct"]["n"], rk)
    except Reject:
        raise
    except Exception:
        raise Reject(7, "authentication")
    content = None
    if t != RT_VAULT_KEY:
        if len(pt) == 0:
            if not env["del"]:
                raise Reject(8, "empty content in a live record")
        else:
            try:
                content = strict_decode(bindings.sodium_unpad(pt, PAD_BLOCK))
            except Exception:
                raise Reject(8, "padding or content encoding")
            if not isinstance(content, dict):
                raise Reject(8, "content not a map")
            if t == RT_RECOVERY_ENVELOPE:
                ok = (isinstance(content.get("keyslotPublicKey"), bytes) and len(content["keyslotPublicKey"]) == 32
                      and isinstance(content.get("phraseId"), bytes) and len(content["phraseId"]) == 16
                      and isinstance(content.get("phraseCreatedAt"), int))
                if not ok:
                    raise Reject(8, "metadata")
    if t in (RT_ITEM, RT_ITEM_VERSION) and content is not None:
        item = content if t == RT_ITEM else content.get("item", {})
        if len(cbor({k: x for k, x in item.items() if k != "trashOperationId"})) > ITEM_CAP:
            raise Reject(9, "item cap")
    if t == RT_VAULT_KEY and env["id"] != blake2b(layout(label("bv.v1.recordid.vault-key"), u32(e)), 16):
        raise Reject(10, "Vault Key recordId")
    if t == RT_RECOVERY_ENVELOPE and env["id"] != blake2b(layout(label("bv.v1.recordid.recovery-envelope"), vault_id), 16):
        raise Reject(10, "Recovery Envelope recordId")
    if t == RT_ITEM_VERSION and content is not None:
        expected = blake2b(layout(content["itemId"], u64(hlc[0]), u32(hlc[1]), hlc[2]), 16, key=k_version)
        if env["id"] != expected:
            raise Reject(10, "versionId")
    return content


def main() -> None:
    v: dict = {"recordFormatVersion": RECORD_FORMAT_VERSION, "generator": "tests/vectors/generate.py"}

    # subkeys
    k_vkwrap = kdf(MASTER_KEY, 1, "bvmaster")
    k_version = kdf(MASTER_KEY, 2, "bvmaster")
    k_readmission = kdf(MASTER_KEY, 3, "bvmaster")
    k_localconfig = kdf(MASTER_KEY, 4, "bvmaster")
    recovery_kek = kdf(PHRASE_ENTROPY, 1, "bvrphras")
    k_envelope = kdf(recovery_kek, 1, "bvrckek_")
    keyslot_seed = kdf(recovery_kek, 2, "bvrckek_")
    keyslot_pk, keyslot_sk = bindings.crypto_box_seed_keypair(keyslot_seed)
    prf_kek = kdf(PRF_OUTPUT, 1, "bvprfkek")

    # layout
    aad_live = record_aad(RT_ITEM, ITEM_ID, KEY_EPOCH, HLC, False)
    aad_deleted = record_aad(RT_ITEM, ITEM_ID, KEY_EPOCH, HLC, True)
    assert len(aad_live) == 105
    v["layout"] = {
        "fields": [
            {"values": ["", "61", "0001"], "layout": h(layout(b"", b"a", u16(1)))},
            {"values": ["6276"], "layout": h(layout(b"bv"))},
        ],
        "recordAad": [
            {
                "recordFormatVersion": 1, "recordType": RT_ITEM, "vaultId": h(VAULT_ID), "recordId": h(ITEM_ID),
                "keyEpoch": KEY_EPOCH, "hlc": {"physicalMs": HLC[0], "counter": HLC[1], "deviceId": h(HLC[2])},
                "deleted": d, "aad": h(a),
            }
            for d, a in ((False, aad_live), (True, aad_deleted))
        ],
        "localAad": [
            {"purpose": p, "vaultId": h(VAULT_ID), "localConfigId": h(LOCAL_CONFIG_ID), "aad": h(local_aad(p))}
            for p in ("bv.v1.mk-wrap.device-kek", "bv.v1.mk-wrap.prf-kek", "bv.v1.local-config")
        ],
    }

    # kdf
    v["kdf"] = {
        "masterKey": h(MASTER_KEY),
        "phraseEntropy": h(PHRASE_ENTROPY),
        "prfOutput": h(PRF_OUTPUT),
        "subkeys": [
            {"parent": "masterKey", "context": "bvmaster", "id": 1, "name": "vaultKeyWrap", "key": h(k_vkwrap)},
            {"parent": "masterKey", "context": "bvmaster", "id": 2, "name": "versionId", "key": h(k_version)},
            {"parent": "masterKey", "context": "bvmaster", "id": 3, "name": "readmission", "key": h(k_readmission)},
            {"parent": "masterKey", "context": "bvmaster", "id": 4, "name": "localConfig", "key": h(k_localconfig)},
            {"parent": "phraseEntropy", "context": "bvrphras", "id": 1, "name": "recoveryKek", "key": h(recovery_kek)},
            {"parent": "recoveryKek", "context": "bvrckek_", "id": 1, "name": "envelope", "key": h(k_envelope)},
            {"parent": "recoveryKek", "context": "bvrckek_", "id": 2, "name": "keyslotSeed", "key": h(keyslot_seed)},
            {"parent": "prfOutput", "context": "bvprfkek", "id": 1, "name": "prfKek", "key": h(prf_kek)},
        ],
        "keyslotKeyPair": {"seed": h(keyslot_seed), "publicKey": h(keyslot_pk), "secretKey": h(keyslot_sk)},
    }

    # ids
    version_id = blake2b(layout(ITEM_ID, u64(HLC[0]), u32(HLC[1]), HLC[2]), 16, key=k_version)
    vk_record_id = blake2b(layout(label("bv.v1.recordid.vault-key"), u32(KEY_EPOCH)), 16)
    env_record_id = blake2b(layout(label("bv.v1.recordid.recovery-envelope"), VAULT_ID), 16)
    v["ids"] = {
        "deviceId": {"staticSecretKey": h(STATIC_SK), "staticPublicKey": h(STATIC_PK), "deviceId": h(DEVICE_ID)},
        "versionId": {
            "versionIdKey": h(k_version), "itemId": h(ITEM_ID),
            "hlc": {"physicalMs": HLC[0], "counter": HLC[1], "deviceId": h(HLC[2])}, "versionId": h(version_id),
        },
        "vaultKeyRecordId": {"keyEpoch": KEY_EPOCH, "recordId": h(vk_record_id)},
        "recoveryEnvelopeRecordId": {"vaultId": h(VAULT_ID), "recordId": h(env_record_id)},
    }

    # bip39
    m = Mnemonic("english")
    words = m.to_mnemonic(PHRASE_ENTROPY)
    assert len(words.split()) == 24 and m.to_entropy(words) == PHRASE_ENTROPY
    typed = "  " + words.upper().replace(" ", "   \t") + "\n"
    bad_checksum = " ".join(words.split()[:-1] + [w for w in m.wordlist if w != words.split()[-1]][:1])
    assert not m.check(bad_checksum)
    v["bip39"] = {
        "entropy": h(PHRASE_ENTROPY), "mnemonic": words, "recoveryKek": h(recovery_kek),
        "envelopeKey": h(k_envelope), "keyslotPublicKey": h(keyslot_pk),
        "acceptedInput": typed,
        "rejectedInput": [
            {"case": "bad checksum", "input": bad_checksum},
            {"case": "23 words", "input": " ".join(words.split()[:23])},
            {"case": "word not in list", "input": " ".join(words.split()[:23] + ["blindvault"])},
        ],
    }

    # argon2id
    decomposed = "pa\u0308ssword\u00a0correct horse"
    nfc_bytes = normalize_password(decomposed)
    assert nfc_bytes == "p\u00e4ssword correct horse".encode("utf-8")
    salt = seq(0xF0, 16)
    ops, mem = 2, 64 * 1024 * 1024
    dkek = pwhash.argon2id.kdf(32, nfc_bytes, salt, opslimit=ops, memlimit=mem)
    v["argon2id"] = {
        "passwordAsTyped": decomposed, "passwordNormalizedUtf8": h(nfc_bytes), "salt": h(salt),
        "normalization": [
            {"input": "cafe\u0301", "output": h(normalize_password("cafe\u0301"))},
            {"input": "a\u00a0b\u2003c", "output": h(normalize_password("a\u00a0b\u2003c"))},
        ],
        "rejectedPasswords": ["", " \u00a0\t\u3000", "abc\u0007def", "line\nbreak"],
        "opslimit": ops, "memlimit": mem, "deviceKek": h(dkek),
        "acceptedRange": {"memlimit": [64 * 1024 * 1024, 256 * 1024 * 1024], "opslimit": [2, 64]},
        "rejectedParameters": [
            {"memlimit": 32 * 1024 * 1024, "opslimit": 2},
            {"memlimit": 512 * 1024 * 1024, "opslimit": 2},
            {"memlimit": 64 * 1024 * 1024, "opslimit": 1},
            {"memlimit": 64 * 1024 * 1024, "opslimit": 65},
        ],
    }

    # pad
    v["pad"] = [{"length": n, "padded": h(pad(bytes([0x41]) * n))} for n in (0, 1, 255, 256, 257)]

    # records (a fresh record key per write, section 9.3)
    content = {"templateId": "login", "templateVersion": 1, "title": "Example"}
    content_cbor = cbor(content)
    rk_item, rk_purged, rk_env = RECORD_KEY, record_key(1), record_key(2)
    item_env = envelope(
        RT_ITEM, ITEM_ID, KEY_EPOCH, HLC, False,
        wk=sealed_cbor(seal(VAULT_KEY, aad_live, rk_item, nonce(1))),
        ct=sealed_cbor(seal(rk_item, aad_live, pad(content_cbor), nonce(2))),
    )
    purged_env = envelope(
        RT_ITEM, ITEM_ID, KEY_EPOCH, HLC, True,
        wk=sealed_cbor(seal(VAULT_KEY, aad_deleted, rk_purged, nonce(3))),
        ct=sealed_cbor(seal(rk_purged, aad_deleted, b"", nonce(4))),
    )
    assert len(purged_env["ct"]["c"]) == 16
    vk_hlc = (1_760_000_000_000, 0, DEVICE_ID)
    vk_aad = record_aad(RT_VAULT_KEY, vk_record_id, KEY_EPOCH, vk_hlc, False)
    vk_env = envelope(
        RT_VAULT_KEY, vk_record_id, KEY_EPOCH, vk_hlc, False,
        ct=sealed_cbor(seal(k_vkwrap, vk_aad, VAULT_KEY, nonce(5))),
    )
    assert len(vk_env["ct"]["c"]) == 48

    env_hlc = (1_760_000_000_000, 1, DEVICE_ID)
    env_aad = record_aad(RT_RECOVERY_ENVELOPE, env_record_id, KEY_EPOCH, env_hlc, False)
    metadata = {"keyslotPublicKey": keyslot_pk, "phraseCreatedAt": 1_760_000_000_000, "phraseId": PHRASE_ID}
    rec_env = envelope(
        RT_RECOVERY_ENVELOPE, env_record_id, KEY_EPOCH, env_hlc, False,
        mk=sealed_cbor(seal(k_envelope, env_aad, MASTER_KEY, nonce(6))),
        wk=sealed_cbor(seal(VAULT_KEY, env_aad, rk_env, nonce(7))),
        ct=sealed_cbor(seal(rk_env, env_aad, pad(cbor(metadata)), nonce(8))),
    )

    def flip_last(sealed):
        c = bytearray(sealed["c"]); c[-1] ^= 1
        return {"n": sealed["n"], "c": bytes(c)}

    def flip_first(sealed):
        c = bytearray(sealed["c"]); c[0] ^= 1
        return {"n": sealed["n"], "c": bytes(c)}

    other_vault = record_aad(RT_ITEM, ITEM_ID, KEY_EPOCH, HLC, False, vault_id=seq(0xA1, 16))
    later_hlc = record_aad(RT_ITEM, ITEM_ID, KEY_EPOCH, (HLC[0] + 1, HLC[1], HLC[2]), False)
    env_later = record_aad(RT_RECOVERY_ENVELOPE, env_record_id, KEY_EPOCH, (env_hlc[0] + 1, env_hlc[1], env_hlc[2]), False)
    must_not_open = [
        ("item wk under the deleted=true AAD", VAULT_KEY, aad_deleted, item_env["wk"]),
        ("item ct under another vaultId", rk_item, other_vault, item_env["ct"]),
        ("item wk under keyEpoch 2", VAULT_KEY, record_aad(RT_ITEM, ITEM_ID, 2, HLC, False), item_env["wk"]),
        ("item ct under a later hlc", rk_item, later_hlc, item_env["ct"]),
        ("item ct under recordType Folder", rk_item, record_aad(RT_FOLDER, ITEM_ID, KEY_EPOCH, HLC, False), item_env["ct"]),
        ("item ct with its tag flipped", rk_item, aad_live, flip_last(item_env["ct"])),
        ("item ct with its first ciphertext byte flipped", rk_item, aad_live, flip_first(item_env["ct"])),
        ("item wk with its tag flipped", VAULT_KEY, aad_live, flip_last(item_env["wk"])),
        ("recovery envelope mk under a later hlc", k_envelope, env_later, rec_env["mk"]),
        ("recovery envelope mk opened as wk (Vault Key)", VAULT_KEY, env_aad, rec_env["mk"]),
        ("recovery envelope wk opened as mk (envelope key)", k_envelope, env_aad, rec_env["wk"]),
    ]
    for _, key, aad, sealed in must_not_open:
        assert not opens(key, aad, sealed)
    v["records"] = {
        "vaultKey": h(VAULT_KEY), "vaultKeyWrapKey": h(k_vkwrap), "envelopeKey": h(k_envelope),
        "maxCiphertextLength": MAX_CT, "itemCap": ITEM_CAP, "maxEnvelopeLength": MAX_ENVELOPE,
        "item": {"recordKey": h(rk_item), "content": content, "contentCbor": h(content_cbor), "aad": h(aad_live),
                 "envelope": h(cbor(item_env))},
        "purgedTombstone": {"recordKey": h(rk_purged), "aad": h(aad_deleted), "envelope": h(cbor(purged_env))},
        "vaultKeyRecord": {"hlc": {"physicalMs": vk_hlc[0], "counter": vk_hlc[1], "deviceId": h(vk_hlc[2])},
                           "aad": h(vk_aad), "envelope": h(cbor(vk_env))},
        "recoveryEnvelope": {"recordKey": h(rk_env), "masterKey": h(MASTER_KEY),
                             "hlc": {"physicalMs": env_hlc[0], "counter": env_hlc[1], "deviceId": h(env_hlc[2])},
                             "metadataCbor": h(cbor(metadata)), "aad": h(env_aad), "envelope": h(cbor(rec_env))},
        "mustNotOpen": [
            {"case": c, "key": h(key), "aad": h(aad), "n": h(sealed["n"]), "c": h(sealed["c"])}
            for c, key, aad, sealed in must_not_open
        ],
    }

    # local wraps
    lc_part = {"securityPreferences": {"autoLockMinutes": 5}}
    v["local"] = {
        "deviceKek": h(dkek), "prfKek": h(prf_kek), "localConfigKey": h(k_localconfig),
        "mkWrapDeviceKek": {k: h(x) for k, x in seal(dkek, local_aad("bv.v1.mk-wrap.device-kek"), MASTER_KEY, nonce(9)).items()},
        "mkWrapPrfKek": {k: h(x) for k, x in seal(prf_kek, local_aad("bv.v1.mk-wrap.prf-kek"), MASTER_KEY, nonce(10)).items()},
        "encryptedPart": {"plaintextCbor": h(cbor(lc_part)),
                          **{k: h(x) for k, x in seal(k_localconfig, local_aad("bv.v1.local-config"), pad(cbor(lc_part)), nonce(11)).items()}},
    }
    dk_wrap = seal(dkek, local_aad("bv.v1.mk-wrap.device-kek"), MASTER_KEY, nonce(9))
    local_must_not_open = [
        ("device-kek wrap under another localConfigId", layout(label("bv.v1.mk-wrap.device-kek"), VAULT_ID, seq(0xB1, 16))),
        ("device-kek wrap under another vaultId", layout(label("bv.v1.mk-wrap.device-kek"), seq(0xA1, 16), LOCAL_CONFIG_ID)),
        ("device-kek wrap under the prf-kek purpose", local_aad("bv.v1.mk-wrap.prf-kek")),
    ]
    for _, aad in local_must_not_open:
        assert not opens(dkek, aad, dk_wrap)
    v["local"]["mustNotOpen"] = [
        {"case": c, "key": h(dkek), "aad": h(aad), "n": h(dk_wrap["n"]), "c": h(dk_wrap["c"])}
        for c, aad in local_must_not_open
    ]

    # transcripts
    payload_i, payload_r = b"pairing payload initiator", b"pairing payload responder"
    fp_i, fp_r = seq(0x10, 32), seq(0x30, 32)
    recon_i, recon_r = b"reconnection payload initiator", b"reconnection payload responder"
    handshake_hash = seq(0x50, 64)
    v["transcripts"] = {
        "dtlsFingerprintInitiator": h(fp_i), "dtlsFingerprintResponder": h(fp_r),
        "prologueXX": {
            "payloadInitiator": h(payload_i), "payloadResponder": h(payload_r),
            "prologue": h(layout(label("bv.pairing.v1"), blake2b(payload_i, 32), blake2b(payload_r, 32), fp_i, fp_r)),
        },
        "prologueKK": {
            "reconnectionInitiator": h(recon_i), "reconnectionResponder": h(recon_r),
            "prologue": h(layout(label("bv.sync.v1"), blake2b(recon_i, 32), blake2b(recon_r, 32), fp_i, fp_r)),
        },
        "readmissionMac": [
            {"role": role, "handshakeHash": h(handshake_hash), "readmissionKey": h(k_readmission),
             "mac": h(blake2b(layout(label("bv.v1.readmission"), label(role), handshake_hash), 32, key=k_readmission))}
            for role in ("initiator", "responder")
        ],
    }

    # negative: each vector violates exactly one rule; every other part is valid, sealed under the
    # AAD of its own (mutated) header, so only the rule at expectedStep (crypto-spec §9.5) rejects it.
    try:
        bindings.sodium_unpad(bytes(PAD_BLOCK), PAD_BLOCK)
        raise AssertionError("all-zero block must fail sodium_unpad")
    except Exception as e:
        if isinstance(e, AssertionError):
            raise
    neg = []
    counter = iter(range(20, 250))

    def add(step, case, data):
        neg.append({"expectedStep": step, "case": case, "envelope": h(data)})

    def item(header=None, plaintext=None, vault_key=VAULT_KEY, rtype=RT_ITEM, extra=None, drop=()):
        hdr = {"v": RECORD_FORMAT_VERSION, "t": rtype, "id": ITEM_ID, "e": KEY_EPOCH, "hlc": list(HLC), "del": False}
        hdr.update(header or {})
        try:
            aad = record_aad(hdr["t"], hdr["id"], hdr["e"], tuple(hdr["hlc"]), bool(hdr["del"]), version=hdr["v"])
        except (struct.error, ValueError):
            aad = aad_live  # header not encodable in the AAD: rejected structurally before any AEAD
        rk = record_key(next(counter))
        pt = pad(content_cbor) if plaintext is None else plaintext
        env = {**hdr,
               "wk": sealed_cbor(seal(vault_key, aad, rk, nonce(next(counter)))),
               "ct": sealed_cbor(seal(rk, aad, pt, nonce(next(counter))))}
        env.update(extra or {})
        for k in drop:
            env.pop(k)
        return env

    good = cbor(item_env)
    pairs = sorted((cbor(k), cbor(x)) for k, x in item_env.items())
    # step 2: encoding
    add(2, "unsorted map keys", _head(5, len(pairs)) + b"".join(k + x for k, x in reversed(pairs)))
    add(2, "non-shortest uint for v", _head(5, len(pairs)) + b"".join(k + (b"\x18\x01" if k == cbor("v") else x) for k, x in pairs))
    add(2, "indefinite-length map", b"\xbf" + good[1:] + b"\xff")
    add(2, "trailing byte", good + b"\x00")
    add(2, "duplicate key", _head(5, len(pairs) + 1) + b"".join(k + x for k, x in pairs[:1]) + b"".join(k + x for k, x in pairs))
    # step 3: structure
    add(3, "del as uint", cbor(item({"del": 0})))
    add(3, "unknown recordType 99", cbor(item({"t": 99})))
    add(3, "reserved recordType Template", cbor(item({"t": 7})))
    add(3, "unknown recordFormatVersion 2", cbor(item({"v": 2})))
    add(3, "keyEpoch 0", cbor(item({"e": 0})))
    add(3, "keyEpoch 2^32", cbor(item({"e": 2**32})))
    add(3, "recordId of 15 bytes", cbor(item({"id": ITEM_ID[:15]})))
    add(3, "hlc with 2 elements", cbor(item({"hlc": [HLC[0], HLC[1]]})))
    add(3, "hlc physicalMs above 2^53-1", cbor(item({"hlc": [2**53, HLC[1], HLC[2]]})))
    add(3, "hlc deviceId of 17 bytes", cbor(item({"hlc": [HLC[0], HLC[1], HLC[2] + b"\x00"]})))
    e = item(); add(3, "ct nonce of 23 bytes", cbor({**e, "ct": {"n": e["ct"]["n"][:23], "c": e["ct"]["c"]}}))
    e = item(); add(3, "wk ciphertext of 47 bytes", cbor({**e, "wk": {"n": e["wk"]["n"], "c": e["wk"]["c"][:47]}}))
    e = item(); add(3, "extra key inside ct", cbor({**e, "ct": {**e["ct"], "x": 1}}))
    add(3, "extra envelope key", cbor(item(extra={"x": 1})))
    add(3, "missing wk", cbor(item(drop=("wk",))))
    add(3, "Vault Key record with wk", cbor({**vk_env, "wk": item_env["wk"]}))
    add(3, "Item with mk", cbor(item(extra={"mk": rec_env["mk"]})))
    # step 4: deletion state not allowed for the type
    vk_del_aad = record_aad(RT_VAULT_KEY, vk_record_id, KEY_EPOCH, vk_hlc, True)
    add(4, "Vault Key record with del true",
        cbor({**vk_env, "del": True, "ct": sealed_cbor(seal(k_vkwrap, vk_del_aad, VAULT_KEY, nonce(next(counter))))}))
    # step 5: ciphertext lengths
    add(5, "padding length not a multiple of 256 (marker at 100 of 300 bytes)",
        cbor(item(plaintext=content_cbor + b"\x80" + bytes(300 - len(content_cbor) - 1))))
    vk_long = seal(k_vkwrap, vk_aad, VAULT_KEY + bytes(16), nonce(next(counter)))
    add(5, "Vault Key ct of 64 bytes", cbor({**vk_env, "ct": sealed_cbor(vk_long)}))
    # step 7: authentication
    add(7, "wk sealed under a Vault Key of an epoch not held (e = 2)", cbor(item({"e": 2}, vault_key=seq(0x21, 32))))
    e = item(); add(7, "ct tag flipped", cbor({**e, "ct": flip_last(e["ct"])}))
    add(7, "Recovery Envelope with wk and mk swapped", cbor({**rec_env, "wk": rec_env["mk"], "mk": rec_env["wk"]}))
    # step 8: plaintext
    add(8, "empty plaintext with del false", cbor(item(plaintext=b"")))
    add(8, "invalid padding (256 zero bytes)", cbor(item(plaintext=bytes(PAD_BLOCK))))
    add(8, "content is an array, not a map", cbor(item(plaintext=pad(cbor(["login"])))))
    bad_meta = {**metadata, "keyslotPublicKey": keyslot_pk[:31]}
    rk = record_key(next(counter))
    add(8, "Recovery Envelope keyslotPublicKey of 31 bytes",
        cbor({**rec_env, "wk": sealed_cbor(seal(VAULT_KEY, env_aad, rk, nonce(next(counter)))),
              "ct": sealed_cbor(seal(rk, env_aad, pad(cbor(bad_meta)), nonce(next(counter))))}))
    # step 10: derived recordId
    wrong_vk_id = blake2b(layout(label("bv.v1.recordid.vault-key"), u32(2)), 16)
    wrong_vk_aad = record_aad(RT_VAULT_KEY, wrong_vk_id, KEY_EPOCH, vk_hlc, False)
    add(10, "Vault Key record whose recordId is that of epoch 2",
        cbor({**vk_env, "id": wrong_vk_id, "ct": sealed_cbor(seal(k_vkwrap, wrong_vk_aad, VAULT_KEY, nonce(next(counter))))}))
    iv_content = {"item": content, "itemId": ITEM_ID}
    add(10, "Item Version whose recordId is not its versionId",
        cbor(item({"id": seq(0x70, 16)}, plaintext=pad(cbor(iv_content)), rtype=RT_ITEM_VERSION)))
    iv_ok = item({"id": version_id}, plaintext=pad(cbor(iv_content)), rtype=RT_ITEM_VERSION)
    v["records"]["itemVersion"] = {"contentCbor": h(cbor(iv_content)), "envelope": h(cbor(iv_ok))}
    future = {**content, "x-future": [1.5, -3, None, 100000.5, 1e300, float("nan"), -0.0]}
    future_env = item(plaintext=pad(cbor(future)))
    v["records"]["itemWithFutureContent"] = {"contentCbor": h(cbor(future)), "envelope": h(cbor(future_env))}
    collision_env = item({"id": vk_record_id})
    v["records"]["identityCollision"] = {
        "case": "valid Item whose recordId equals the Vault Key recordId of epoch 1: a different record (D158)",
        "recordId": h(vk_record_id), "envelope": h(cbor(collision_env)),
    }
    def raw_content(extra_value: bytes) -> bytes:
        items = sorted([(cbor(k), cbor(x)) for k, x in content.items()] + [(cbor("x-future"), extra_value)])
        return _head(5, len(items)) + b"".join(k + x for k, x in items)
    add(8, "content float 1.5 encoded as float64", cbor(item(plaintext=pad(raw_content(b"\xfb" + struct.pack(">d", 1.5))))))
    add(8, "content holding a tag", cbor(item(plaintext=pad(raw_content(b"\xc1\x00")))))
    add(8, "content holding undefined", cbor(item(plaintext=pad(raw_content(b"\xf7")))))
    add(8, "content NaN with a non-canonical payload", cbor(item(plaintext=pad(raw_content(b"\xf9\x7e\x01")))))

    # every valid record passes the reference verifier; every negative vector fails at its step
    held = {KEY_EPOCH: VAULT_KEY}
    for name in ("item", "purgedTombstone", "vaultKeyRecord", "recoveryEnvelope", "itemVersion",
                 "itemWithFutureContent", "identityCollision"):
        verify(bytes.fromhex(v["records"][name]["envelope"]), VAULT_ID, held, k_vkwrap, k_version)
    for n in neg:
        try:
            verify(bytes.fromhex(n["envelope"]), VAULT_ID, held, k_vkwrap, k_version)
            raise AssertionError(f"accepted: {n['case']}")
        except Reject as r:
            assert r.step == n["expectedStep"], f"{n['case']}: rejected at step {r.step}, expected {n['expectedStep']} ({r})"

    for n in neg:
        assert len(bytes.fromhex(n["envelope"])) <= MAX_ENVELOPE
    v["negative"] = {
        "envelopes": neg,
        "byLength": [
            {"expectedStep": 1, "case": "envelope longer than maxEnvelopeLength", "envelopeLength": MAX_ENVELOPE + 1},
            {"expectedStep": 5, "case": "ct.c longer than maxCiphertextLength", "ctLength": MAX_CT + 1},
            {"expectedStep": 9, "case": "item content longer than itemCap", "itemContentLength": ITEM_CAP + 1},
        ],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(v, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
