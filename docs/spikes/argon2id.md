# Spike result — Argon2id in the browser (D9, D126)

Status: **done, except the optional 1 GiB ops 4 run**. Samsung A54 (Chrome), Windows laptop
(Chrome, Firefox), MacBook Air M1 (Chrome, Firefox, Safari) and iPhone 14 (Safari) measured, 1 GiB
included. The 64 MiB floor is viable on iOS and D9 stands; 1 GiB runs on every browser and D126
stands (see Conclusion).

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

## Windows laptop, Chrome 155 (2026-10-10)

Reports 8 cores and 16 GiB of device memory. All runs succeeded.

| Memory | ops 2 | ops 3 |
| --- | --- | --- |
| 64 MiB | 111 ms | 146 ms |
| 128 MiB | 224 ms | 314 ms |
| 256 MiB | 463 ms | 673 ms |
| 1 GiB | 1,961 ms | 2,960 ms |

- **Calibration at 64 MiB:** ops 19 is the first to reach 1 s (1,003 ms), inside the accepted range.
- 1.6 to 1.9 times as fast as the A54, cell by cell.

## Windows laptop, Firefox 157 (2026-10-10)

Same laptop. Firefox does not expose `deviceMemory`. All runs succeeded.

| Memory | ops 2 | ops 3 |
| --- | --- | --- |
| 64 MiB | 158 ms | 218 ms |
| 128 MiB | 347 ms | 463 ms |
| 256 MiB | 692 ms | 1,063 ms |
| 1 GiB | 3,015 ms | 4,592 ms |

- **Calibration at 64 MiB:** ops 13 is the first to reach 1 s (1,095 ms). The steps are noisier
  than in Chrome (ops 11 ran faster than ops 10).
- 1.4 to 1.6 times slower than Chrome on the same laptop, so the same laptop calibrates to ops 19 in
  Chrome and ops 13 in Firefox. Calibration is per installation (D9), so each keeps about 1 s.

## MacBook Air M1, Chrome 155 (2026-10-10)

Reports 8 cores and 16 GiB of device memory. All runs succeeded.

| Memory | ops 2 | ops 3 |
| --- | --- | --- |
| 64 MiB | 79 ms | 113 ms |
| 128 MiB | 159 ms | 231 ms |
| 256 MiB | 321 ms | 474 ms |
| 1 GiB | 1,387 ms | 1,989 ms |

- **Calibration at 64 MiB:** ops 29 is the first to reach 1 s (1,025 ms), inside the accepted range.
- The fastest device so far, with the steadiest times (spread within a cell under 10% except the
  first 64 MiB run).

## MacBook Air M1, Firefox 157 (2026-10-10)

Same Mac. All runs succeeded.

| Memory | ops 2 | ops 3 |
| --- | --- | --- |
| 64 MiB | 113 ms | 145 ms |
| 128 MiB | 210 ms | 295 ms |
| 256 MiB | 424 ms | 599 ms |
| 1 GiB | 1,694 ms | 2,445 ms |

- **Calibration at 64 MiB:** ops 23 is the first to reach 1 s (1,022 ms).
- 1.2 to 1.4 times slower than Chrome on the same Mac, a smaller gap than on Windows.

## iPhone 14, Safari 26.6 (2026-10-12)

Safari tab, not the installed app. The user agent says iOS 18_7, but Safari 26 freezes that field;
the Safari version is the reliable one. Reports 4 cores (Safari caps `hardwareConcurrency`) and no
`deviceMemory`. All runs succeeded, no reload or crash.

| Memory | ops 2 | ops 3 |
| --- | --- | --- |
| 64 MiB | 81 ms | 118 ms |
| 128 MiB | 163 ms | 245 ms |
| 256 MiB | 337 ms | 501 ms |
| 1 GiB | 1,437 ms | 2,145 ms |

- **Calibration at 64 MiB:** ops 28 is the first to reach 1 s (1,028 ms), inside the accepted range
  (ops 2..64). About 37 ms per extra pass, linear across the whole ladder.
- Spread within a cell is under 10%, except the first 64 MiB run of the session (101 ms against 80).
- As fast as Chrome on the M1 cell by cell, and 2.2 to 2.4 times as fast as the A54.
- **1 GiB (D126):** runs in a Safari tab on iOS. The live build ran ops 2 and 3; one pass costs about
  0.7 s, so ops 4 would land near 2.9 s by extrapolation, not measured.

## MacBook Air M1, Safari 26.6 (2026-10-12)

Same Mac. Safari reports 8 cores and no `deviceMemory`. All runs succeeded.

| Memory | ops 2 | ops 3 |
| --- | --- | --- |
| 64 MiB | 81 ms | 118 ms |
| 128 MiB | 163 ms | 237 ms |
| 256 MiB | 323 ms | 484 ms |
| 1 GiB | 1,338 ms | 1,993 ms |

- **Calibration at 64 MiB:** ops 27 is the first to reach 1 s (1,020 ms).
- Within a few percent of Chrome on the same Mac, cell by cell, and of Safari on the iPhone: WebKit's
  WASM runs libsodium as fast as V8 here, unlike Firefox.

## Conclusion (D9)

The 64 MiB floor is viable on every device measured, iOS Safari included: 64 MiB reaches about 1 s
at ops 12 (A54, the slowest) to 29 (M1 Chrome), always inside the accepted range, and no run failed.
D9 stands unchanged. The iPhone is one of the fastest devices measured, so the A54 remains the
binding case for the fixed export parameters (D78).

**D126:** 1 GiB ran in a worker on every browser of the matrix (A54 Chrome, Windows Chrome and
Firefox, Mac Chrome, Firefox and Safari, iPhone Safari) with no failure, so a `.blindpass` import
at libsodium's `SENSITIVE` memory limit is feasible everywhere. D126 stands. The slowest 1 GiB pass
was the A54's, about 1.3 s, so ops 4 lands near 6 s there by extrapolation.

## Pending

- Optional: the 1 GiB button runs ops 4 (D126's limits) from the next deploy; the A54, the slowest
  device, can rerun it.
