# Initial loading reliability and UX

2026-11-05; baseline: `1d84ad4` (Phase 5). Optical data and calculations are unchanged.

## Findings

The published `background.qWNzYUGU.png` returned HTTP 200, image/png, 3,319,445 bytes. Its SHA-256 exactly matched the checked-out source (`174ed5225978fa769be73b240502760cf813fe0fd4738510821951e86e001939`). GitHub Pages exposed ETag/Last-Modified and Cache-Control max-age=600. No missing path, truncated file, or current deployment mismatch was found during inspection. The original asset is a valid 1024×1536 RGB PNG, including a 95 KB ancillary caBX block.

Two reproducible causes of poor cold-load behavior were identified:

1. A 1024×1024 favicon unnecessarily downloaded **1,423,220 bytes** alongside the **3,319,445-byte** background. The measured original cold-load payload was about 4.92 MB, despite the icon appearing at only a few pixels.
2. `Promise.all(background, card)` gated all scene initialization on that large background. A background failure discarded the otherwise usable card. Native Image.onerror merged HTTP, transport and decode errors; two 60 s request attempts could leave the scene unavailable for about two minutes without measurable progress.

The desktop could not reproduce the user's exact physical-phone decoder failure. Payload size, an all-or-nothing dependency, long retry waits and missing diagnostics are confirmed; caBX decoder incompatibility or a specific Safari defect is **not** a proven root cause. Repacking removes ancillary data but is not presented as proof that the block itself was defective.

## Changes

- Losslessly repack the same RGB PNG with Pillow: **2,833,899 bytes** (486 KB / 14.6% smaller). All 4,718,592 RGB bytes are unchanged. Resize only the favicon to 64×64 / **2,938 bytes**. Reproduce with `uv run --project optics python optics/prepare_scene_assets.py`; source dimensions and encoded/decoded hashes are recorded in `src/lib/assets/images/background.json`.
- Load ETDRS through its real native SVG URL and initialize the chart independently. A labelled neutral background is used only while the actual background is pending/unavailable; it is not represented as a completed far-scene simulation. Header, settings, calibration, lens selection and near chart remain usable. The actual full-resolution background replaces the placeholder atomically and invalidates the placeholder's Worker/background caches.
- PNG HTTP streaming reports **received bytes / expected bytes**, then a separate decode stage. Unknown totals, native fallback, PSF loading and rendering show their current stage without fabricated percentages. The previous completed image stays visible during optical-image downloads.
- Validate HTTP status, content type, PNG signature and expected response length. Retry transient transfers once with a short delay; do not retry permanent HTTP/MIME errors blindly. Header/body inactivity limit is 10 s; total budgets include retries: background 45 s, optical PNG 18 s, PSF 30 s, manifests 12 s. Native card load has one 15 s attempt. PNG Blob decode is bounded to 8 s, with one real-URL native fallback for unavailable/rejected Blob URLs (also for browser fetch restrictions), within the overall PNG budget. Worker requests have a 30 s deadline and a recoverable reset.
- Retain a PNG Blob URL until its owner releases the decoded image, and keep SVGs off the Blob path. Abort obsolete transfers and release temporary images/URLs and progress listeners. A background retry preserves the card and controls. Separate chart/render retries and an existing-Gaussian recovery action handle other failures. Optical-image failure explicitly reports dynamic PSF fallback.
- Optical images remain lazy. No optical library/PSF downloads start in the default Gaussian mode. Speculative loads wait for the actual background and completed frame, are skipped for save-data/2G/3G or reported device memory below 4 GB, and retain the existing ±0.1 D / two-neighbor / 4 MiB-per-prefetch and 16 MiB decoded optical-cache limits. The PSF cache remains bounded; no new startup preloading is added.

## Validation

Frozen baseline and new production build, same desktop Chromium, 390×844 CSS viewport / 390×622 Gaussian samples, 6.692913 CSS px/mm, 40 cm, 4× CPU, HTTP cache disabled, 150 ms latency / 200,000 bytes/s. Two runs each; timing starts at navigation and ends when a completed frame's profile is published, not at physical screen scanout:

| Measurement | Baseline | Updated |
|---|---:|---:|
| Near chart available, run 1 | 27.95 s | 2.78 s |
| Near chart available, run 2 | 26.69 s | 2.93 s |
| Complete scene, run 1 | 27.95 s | 17.07 s |
| Complete scene, run 2 | 26.69 s | 18.29 s |
| Encoded response payload, run 2 | 4,915,384 bytes | 3,013,652 bytes |

With HTTP cache enabled, refresh completed the chart at 0.77 s and full scene at 1.36 s under the same emulation. One warm observation is not a broad performance guarantee. A 20,000 bytes/s optical-image test visibly reported actual progress (e.g. 1,500 / 62,701 bytes) while retaining the previous image. Raw observations and screenshots are retained locally in ignored `optics/outputs/loading-*` files.

Integrity and runtime checks:

- **36 automated tests pass**, including streamed byte counts, 503 retry, permanent 404/MIME rejection, stalled headers/body cancellation, total deadlines, explicit abort, Blob URL lifetime/native fallback, low-bandwidth prefetch policy and original RGB hash.
- Existing 96 PSFs, 62 optical PNGs, source hashes, energy, angular scaling, linear-light composition and identical-grid optical/dynamic/Python comparisons pass unchanged. No ray tracing or PSF regeneration was performed.
- The complete Gaussian scene screenshot matches the frozen baseline at **every RGB channel** (390×622 pixels, max difference 0). Actual browser PNG decode checks every original RGB byte against its original hash.
- `/validation`: all original Worker/WebGL native-resolution errors 0, scaled-display errors 1 byte; Aspheric optical-image canonical cases 1 byte; 50% linear-light midpoint 188/255; new background decode check PASS.
- Real browser resource blocking: missing background leaves Gaussian and precomputed Aspheric near charts functional; unblocking and `Retry background` restores the full scene. Disabling Blob URL creation still restores through the native URL. Missing optical images use dynamic FFT; unblocking restores precomputed loading. Aspheric/Vivity mixed split-view succeeds. Missing ETDRS SVG exposes `Retry chart`, which restores without repeating the background download. PSF errors expose render retry / Gaussian recovery.

## Limits

Measurements are desktop emulation, **not physical iPhone/Android or private-browsing acceptance**. The exact original phone error remains unproven. The background still contains 1.57 million pixels and about 2.83 MB of lossless data; very slow connections may reach the explicit budget and leave a clearly labelled partial scene requiring retry. Decode, shader setup and a new infinity-PSF background computation still cost time. Encoded/decoded image buffers, Worker copies and GPU allocations exist outside the optical/PSF cache limits; total mobile RAM reduction is not claimed.

The neutral loading background is a recovery state, not a lower-quality substitute for the final scene. Complete-scene RGB samples, optical libraries, angular scaling and rendering precision remain unchanged. A physical phone must still confirm browser-specific transport/decode behavior and perceived responsiveness after deployment.
