"""Feasibility audit: angular image scaling versus direct PSF convolution.

This deliberately compares different raster grids; it reports the sampling
error instead of treating a resized image as an exact discrete FFT result.
"""
import argparse
import json
from pathlib import Path
import numpy as np
import pymupdf
from PIL import Image
from angular_sampling import resample
from export_optical_images import PUBLIC, ROOT, MODEL, read_psf, optical_layer
from validate_library import encode


def unpack(path):
    rgb = np.asarray(Image.open(path).convert('RGB')).astype(np.uint16)
    return ((rgb[:, :, 0] << 4) | (rgb[:, :, 1] >> 4)) / 4095, (((rgb[:, :, 1] & 15) << 8) | rgb[:, :, 2]) / 4095


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--library', type=Path, default=PUBLIC / 'optical-images')
    parser.add_argument('--source-density', type=int, default=0)
    parser.add_argument('--reference-density', type=int, default=16384)
    args = parser.parse_args()
    library = json.loads((args.library / 'manifest.json').read_text('utf8'))
    psfs = json.loads((PUBLIC / 'psf/manifest.json').read_text('utf8'))
    doc = pymupdf.open(PUBLIC / 'reading-card.svg')
    rows = []
    for node in library['entries']:
        demand = node['objectVergenceD']
        entry = next(e for e in psfs['entries'] if e['model'] == MODEL and e['objectVergenceD'] == demand)
        energy = read_psf(entry)
        rf, ra, reference = optical_layer(doc[0], entry, energy, demand, args.reference_density)
        for density in [128, 256, 512, 800, 1200, 2000, 4000, 7000, 8192]:
            level = (next(l for l in node['levels'] if l['density'] == args.source_density)
                     if args.source_density else next(l for l in node['levels'] if l['density'] >= max(4096, density)))
            fg, alpha, target = optical_layer(doc[0], entry, energy, demand, density)
            stored_f, stored_a = unpack(args.library / level['file'])
            pf, pa = resample(stored_f, level, target), resample(stored_a, level, target)
            expected_f, expected_a = resample(rf, reference, target), resample(ra, reference, target)
            rgba_errors = []
            legacy_errors = []
            for bg in [.0, .15, .4, 1.]:
                expected = encode(expected_f + (1 - expected_a) * bg).astype(float)
                legacy = encode(fg + (1 - alpha) * bg).astype(float)
                actual = encode(pf + (1 - pa) * bg).astype(float)
                rgba_errors.append((actual - expected).ravel())
                legacy_errors.append((actual - legacy).ravel())
            errors = np.concatenate(rgba_errors)
            mass_error = stored_a.sum() / (level['cardPixels'][0] * level['cardPixels'][1]) - 1
            rows.append({'demand': demand, 'targetDensity': density, 'sourceDensity': level['density'],
                         'linearRmse': float(np.sqrt(np.mean((pf-expected_f)**2))),
                         'srgbRmse': float(np.sqrt(np.mean(errors**2))), 'maxByteError': float(abs(errors).max()),
                         'legacyMaxByteError': float(abs(np.concatenate(legacy_errors)).max()),
                         'alphaAreaRelativeError': float(mass_error)})
    path = ROOT / 'optics/outputs/precomputed-sampling-audit.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    summary={key:max(abs(row[key]) for row in rows) for key in ['linearRmse','srgbRmse','maxByteError','legacyMaxByteError','alphaAreaRelativeError']}
    passed=summary['linearRmse']<=.001 and summary['maxByteError']<=1 and summary['alphaAreaRelativeError']<=1e-4
    path.write_text(json.dumps({'passed':passed,'summary':summary,'comparisons': rows}, indent=2) + '\n', encoding='utf8')
    for row in rows:
        print(row, flush=True)
    print(json.dumps({'passed':passed,'summary':summary}),flush=True)
    assert passed,'Optical image convergence/energy gate failed'


if __name__ == '__main__':
    main()
