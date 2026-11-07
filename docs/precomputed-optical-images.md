# Aspheric precomputed optical images

Phase 5 proof of concept, 2026-11-05. No new ray tracing, eye parameters or PSFs.

Runtime follow-up: [Phase 7](phase7-rendering-optimization.md) replaces the expanded main-thread cache with Worker-owned packed caching and asset IDs. The format and numerical results below remain applicable; performance/cache measurements below describe the Phase 5 baseline.

[Phase 8](phase8-unified-rendering.md) covers the current three-model library, release densities and shared validation path.

## Reproduction and format

Run with the locked `optics/` uv environment:

```powershell
uv run --project optics python optics/export_optical_images.py
uv run --project optics python optics/export_optical_validation.py
uv run --project optics python optics/validate_optical_images.py
npm run test:optics
npm run check
npm run build:gh-pages
```

The 31 Aspheric nodes cover positive object demand 1.0–4.0 D in 0.1 D steps (the UI uses negative defocus). Each uses the existing, authenticated distance-corrected OPTrace photopic-Y PSF and the existing 28 mm tall ETDRS-style card. MuPDF rasterizes vector coverage; SciPy performs full, zero-padded convolution of both linear foreground radiance and coverage. No Gaussian substitute or PSF recentering is used.

Coordinates are tan(theta), x right and y down, with card bottom centre at (0,0). Display pixels per tan(theta) are viewing distance in mm × calibrated CSS px/mm × actual rendering scale, separately for X/Y. Device pixel ratio controls final presentation only. The offline PSF resampling uses the existing retinal-mm/tan(theta) projection and area-overlap kernel integration.

Two densities, nominally 4096 and 8192 pixels/tan(theta), retain the full convolution support. Actual pitches account for integer raster dimensions. Opaque RGB PNG packs premultiplied linear radiance f and coverage a as two 12-bit samples: R=f>>4, G=((f&15)<<4)|(a>>8), B=a&255. Numeric samples are not sRGB encoded. Quantization is at most 0.5/4095 per channel. Manifest records dimensions, angular extents, source PSF/card hashes, encoded-file and decoded-RGBA hashes, coverage energy and centroid. The stale reading-card.json hash was corrected to the existing LF-normalized SVG; the SVG itself did not change.

The browser verifies decoded samples, conservatively integrates angular cells over output pixels, composites over a separately cached infinity-PSF background in linear light, then encodes sRGB. The existing WebGL display still reconstructs linear light at final display resolution. Near distance alone does not invalidate the Aspheric background grid/cache. Mixed comparisons retain the dynamic lens's bounded FFT sampling policy.

## Numerical results

All 31 nodes and both PNG levels pass source/hash/energy checks. At identical canonical grids and input radiance, 1.0/2.5/4.0 D precomputed, original dynamic FFT and independent Python references agree within 1 byte/channel. Actual browser Worker/WebGL readback also passes these cases; existing three-model fixtures retain 0-byte native-resolution and at most 1-byte scaled-display error. A 50% linear black/white sample remains 188/255.

The full convergence audit compares all 31 nodes at target angular densities 128, 256, 512, 800, 1200, 2000, 4000, 7000 and 8192 against a 16384-density SciPy field, with linear background levels 0/.15/.4/1: 279 comparisons pass. Worst foreground linear RMSE 0.000914321, composite sRGB RMSE 0.249577 byte, maximum composite error 1 byte. Worst coverage-area relative error 0.000018319 (0.001832%); each decoded coverage centroid differs from its analytic convolution centroid by less than 0.05 source pixel. Full raw audits remain in ignored optics/outputs/.

The old dynamic renderer rasterizes the card and PSF directly on a coarse display grid. Across different grids it can differ from the converged angular field by up to 64 sRGB bytes at an individual edge pixel. Therefore this change does **not** claim pixel identity with coarse legacy rendering. Identical-grid agreement and convergence toward the denser reference are separate checks. Cell integration preserves energy rather than using unverified image resizing.

## Browser measurements and limits

Frozen f597d9f versus this version, same Windows Chromium, 390×844 CSS viewport / 390×622 samples, 6.692913 CSS px/mm, 40 cm viewing distance, 4× CPU throttle. Same five warm inputs -2.5/-2.6/-2.5/-2.4/-2.5 D: median input-to-submit 227 ms → 111 ms (~51% reduction). This includes Worker transfer/composition and submission, not physical screen scanout. New near FFT time is zero. All 31 nodes were exercised without near/background reconvolution on slides. A five-input burst spaced 20 ms apart settled on the final 2.4 D image in about 97 ms at normal CPU speed.

Cold default Gaussian load, HTTP cache disabled, 150 ms latency / 200000 bytes/s, 4× CPU: old 26.84 s, new 27.29 s (one run each, effectively comparable). Both request the same 3,319,445-byte background PNG and native SVG, with no optical-image download until Physics is selected. The original native Image.src compatibility path is retained. These are desktop emulation measurements, not an iPhone/Android benchmark or a 60 FPS claim.

The 62 PNGs total 16,474,418 bytes, downloaded on demand, not at startup. Decoded radiance/coverage LRU is bounded to 16 MiB; idle ±0.1 D prefetch is limited to two neighbors and skipped for >4 MiB decoded layers. In-flight obsolete images are cancelled. Worker copies, temporary canvas/PNG decode buffers, background caches and GPU allocations are additional memory. High density 4 D can use about 13 MiB for one layer. Large unprefetched jumps still wait for the network.

Browser checks cover 20/100 cm, credit-card matches 270/420 px, rapid slides, Gaussian, Spherical/Vivity dynamic rendering and mixed split-view. Background must be recomputed after calibration/view-distance/grid/model changes; this can still take seconds. Other lenses retain dynamic near FFT costs. Optical-image failures or densities outside the validated 128–8192 range fall back to the original dynamic renderer. There is no new user engine switch or performance mode.

Optical scope remains on-axis, shift-invariant, fixed 3 mm pupil/average cornea, finite PSF support, scalar photopic-Y applied to RGB, geometric tracing plus existing HURB assumptions. No new chromatic, field-dependent, clinical or panel-response validation is implied. Final acceptance requires the user's physical phone.
