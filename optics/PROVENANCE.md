# Optical model and asset provenance

The necessary `src/iol_sim` modules and four model JSON files were copied without changes from the user's `IOLsimulator_optrace` research workspace. They are the backend and frozen distance-corrected models used by `offline_rendering_v3_1`, not newly recovered commercial prescriptions. The research workspace is read-only. The export manifest authenticates these sources by SHA-256.

OPTrace is pinned to `adad608acedb08c2d99688613fa01034865c9d47`, version 1.8.3. Its MIT notice is retained in `OPTRACE_LICENSE`. Source: https://github.com/drocheam/optrace . The offline program delegates surface refraction, ray tracing, dispersion, HURB and detector binning to OPTrace.

The aspheric baseline uses illustrative geometry from Alcon patent US7350916B2, not a verified commercial IOL prescription: https://patents.google.com/patent/US7350916B2/en . The spherical control is a paraxially matched baseline and includes the frozen quadratic correction; it is not an exact two-sphere lens.

The synthetic EDOF profile incorporates Garzón et al.'s public NIMO data, DOI https://doi.org/10.5281/zenodo.18084296 (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/), related article https://doi.org/10.1007/s00417-024-06469-y . Changes inherited from the research model include relative radial-power extraction, smoothing, tapering, integration onto an assumed anterior surface, base-power/quartic corrections and frozen distance correction. This is a design-informed synthetic surrogate, not a disclosed Vivity prescription or a clinical validation result. Its full derivation parameters and dataset hash remain in the model JSON.

The ETDRS source is the public-domain Wikimedia vector https://commons.wikimedia.org/wiki/File:ETDRS_Chart_2.svg, also used by OPTrace's image preset. `export_card.py` applies the same seven-row crop as offline v3.1, adds white backing and records source/output hashes plus physical dimensions in `static/reading-card.json`. The illustrative display is not a certified clinical acuity chart. The background image is the existing App asset and is not replaced with a research photograph.

Method references:

- OPTrace PSF convolution: https://drocheam.github.io/optrace/usage/convolve.html
- Mendroch et al. 2024: https://doi.org/10.1167/tvst.13.8.33
- Mendroch et al. 2025: https://doi.org/10.1167/tvst.14.12.33

The browser uses an achromatic photopic-Y convolution approximation. This is not the fully wavelength-resolved color pipeline in the research literature. Geometric optics/HURB, finite field of view, sampled PSF bins, cropped tails, scene-depth assumptions and mobile display sampling remain explicit limits. Full parameters and validation results are documented in the local, ignored README.
