# Spike result — Argon2id in the browser (D9, D126)

Status: **in progress**. Samsung A54 (Chrome) measured, 1 GiB included; the other devices pending.

Setup: `libsodium-wrappers-sumo` 0.8.4 `crypto_pwhash` (Argon2id 1.3, parallelism 1), in a fresh
Web Worker per run. Times exclude worker start and libsodium load (`loadMs`, under 50 ms everywhere).
Each matrix cell ran 3 times; the median is shown.

## Samsung A54, Chrome 155 (2026-10-10)

Reports 8 cores and 8 GiB of device memory.

| Memory | ops 2 | ops 3 |
| --- | --- | --- |
| 64 MiB | 194 ms | 271 ms |
| 128 MiB | 410 ms | 556 ms |
| 256 MiB | 781 ms | 1,152 ms |

- Every run succeeded; spread within a cell is under 10%.
- Time grows linearly with memory and with ops: about 80 ms per extra pass at 64 MiB.
- **Calibration at 64 MiB:** ops 12 is the first to reach 1 s (1,074 ms). That fits inside the
  accepted range (ops 2..64, crypto-spec §6), so D9's ~1 s target works on this phone at the
  64 MiB floor.
- 256 MiB at ops 2 takes under 1 s too: on this phone, more memory at fewer passes is an option the
  calibration doesn't use today.

### 1 GiB (D126)

Button 3 ran twice: 6 runs per cell, all succeeded, no reload or crash.

| Memory | ops 2 | ops 3 |
| --- | --- | --- |
| 1 GiB | 3,250–3,391 ms | 4,603–4,833 ms |

- The A54 can allocate 1 GiB in a worker, which was the open risk for importing a `.blindpass`.
- D126 uses libsodium's `SENSITIVE` limits, whose `opslimit` is 4; the spike measured only 2 and 3.
  One pass costs about 1.3 s here, so ops 4 would land near 6 s by extrapolation, not measured.
  Acceptable for a one-off import behind a progress indicator.

## Pending

- The 1 GiB button now runs ops 4 (D126's limits) from the next deploy; the A54 can rerun it.
- iPhone 14 (Safari), MacBook Air M1 (Safari, Chrome, Firefox), Windows laptop (Chrome or Edge,
  Firefox). Safari on the iPhone and the Mac only on storage follow-up days or after day 15.
