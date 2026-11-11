# Optical model and asset provenance

The necessary `src/iol_sim` modules and four model JSON files were copied without changes from the user's `IOLsimulator_optrace` research workspace. They are the backend and frozen distance-corrected models used by `offline_rendering_v3_1`, not newly recovered commercial prescriptions. The research workspace is read-only. The export manifest authenticates these sources by SHA-256.

optrace is pinned to `adad608acedb08c2d99688613fa01034865c9d47`, version 1.8.3. Its MIT notice is retained in `OPTRACE_LICENSE`. The offline program delegates surface refraction, ray tracing, dispersion, HURB and detector binning to optrace. [Source repository](https://github.com/drocheam/optrace)

**Alcon Aspheric Monofocal** uses the SN60WF reference geometry in the published optrace target-imaging example, which cites Alcon patent US7350916B2. The shipped PSFs use the project's frozen anterior quadratic correction and eye setup. **Synthetic Spherical Monofocal** uses a paraxially matched baseline with its own frozen quadratic correction. [optrace example](https://github.com/drocheam/optrace/blob/adad608acedb08c2d99688613fa01034865c9d47/examples/IOL_target_imaging.py) · [Alcon patent](https://patents.google.com/patent/US7350916B2/en)

**Synthetic Refractive EDOF** approximates Vivity-like optical behavior using Garzón et al.'s public NIMO data. The model uses relative radial-power extraction, smoothing, tapering, integration onto an assumed anterior surface, base-power and quartic corrections, and frozen distance correction. The model JSON records the derivation parameters and dataset hash. [NIMO data](https://doi.org/10.5281/zenodo.18084296) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) · [Related article](https://doi.org/10.1007/s00417-024-06469-y)

The Phase 12 scene uses an original ID-1 reading card and a generated streetscape. `static/reading-card.json` records physical dimensions and the card hash. The image manifests bind the card hash to the existing PSF hashes. [Scene provenance and scale](../docs/phase12-demo-redesign.md)

Method references:

- [optrace PSF convolution](https://drocheam.github.io/optrace/usage/convolve.html)
- Mendroch et al. 2024: https://doi.org/10.1167/tvst.13.8.33
- Mendroch et al. 2025: https://doi.org/10.1167/tvst.14.12.33

The browser uses an achromatic photopic-Y convolution approximation. This is not the fully wavelength-resolved color pipeline in the research literature. Geometric optics/HURB, finite field of view, sampled PSF bins, cropped tails, scene-depth assumptions and mobile display sampling remain explicit limits. Full parameters and validation results are documented in the local, ignored README.
