# Mobile IOL Simulator

https://raywentsai.github.io/IOLsimulator_mobile_optrace/

Initialized from [IOLsimulator_mobile](https://github.com/raywentsai/IOLsimulator_mobile), source commit `d5effaa575273dc7b30f0a4e1872dd2c816b319a`, with an independent Git history.

The IOL choices are enVista Monofocal, 1-piece Monofocal (TECNIS ZCB00), and Vivity. Their original defocus/logMAR curve values and the existing WebGL renderer are retained. These are legacy illustrative models. This stage adds no OPTrace, Python, PSF library, or new optical calculations.

The existing comparison, holding distance, target refraction, credit-card calibration, viewing distance, presbyopia, and cataract controls are retained. The phakic model curve supports the existing presbyopia mode and is not an IOL option.

## Development

Use Node.js 24 and npm:

```sh
npm ci
npm run dev
npm run check
npm run test:optics
npm run build:gh-pages
npm run preview:gh-pages
```

Production preview is served at `/IOLsimulator_mobile_optrace/`. SvelteKit owns the production base path in `svelte.config.js`; images and fonts are imported through Vite and the favicon uses `%sveltekit.assets%`.

## Deployment

In the new repository's Settings > Pages, select **GitHub Actions** as the source. A push to `main` triggers `.github/workflows/pages.yml`, which installs the lockfile dependencies, checks types, runs regression tests, builds the static site, and deploys its artifact to GitHub Pages. The workflow can also be run manually.

Only commit or push when explicitly requested, as specified in `AGENTS.md`.

## Validation notes

The inherited regression test for automatic 16x downsampling was stale: upstream explicitly commented out that policy. The test now asserts the existing full-resolution behavior; the renderer and optical mapping remain unchanged. Regression coverage also checks the three IOL choices, curve structure, calibration snapshot round-tripping, and physical blur normalization.

The inherited dependency lockfile reports 21 npm audit findings (3 low, 6 moderate, 12 high). Dependency modernization is deferred to preserve this migration's scope. SvelteKit's build also reports a Svelte 4 `untrack` export warning; its client code provides an explicit fallback for Svelte 4.
