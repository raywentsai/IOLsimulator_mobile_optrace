"""Preconvolve the existing ETDRS card with authenticated IOL PSFs.

No ray tracing. Coordinates are tan(theta), not screen/device pixels. PNG RGB
stores two linear 12-bit channels (premultiplied radiance and coverage); alpha
is opaque so native image decoding cannot premultiply away numeric bits.
"""
import argparse
import gzip
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import pymupdf
import scipy
from PIL import Image
from scipy.signal import fftconvolve
from validate_library import scaled_kernel

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / 'static'
MODELS = {
    'aspheric_monofocal_dc_v1': 'aspheric',
    'spherical_monofocal_dc_v1': 'spherical',
    'vivity_inspired_v2_1_dc_v1': 'vivity',
}
DENSITIES = [4096, 8192]
# Minimum source grids that pass the dense-reference convergence gate.
# The exceptions are confined to nodes with a sharper low-vergence response.
MINIMUM_DENSITIES = {
    'spherical_monofocal_dc_v1': dict.fromkeys([10, 11, 12, 13, 14, 15, 16, 19], 8192),
    'vivity_inspired_v2_1_dc_v1': {
        10: 16384, 11: 16384, 12: 12288, 13: 8192, 14: 8192, 15: 8192, 16: 8192, 17: 8192,
    },
}
HEIGHT_MM, ASPECT = 28., 1528 / 1170


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_psf(entry):
    raw = gzip.decompress((PUBLIC / 'psf' / entry['file']).read_bytes())
    assert sha(raw) == entry['sha256']
    energy = np.frombuffer(raw, '<f4').reshape(entry['height'], entry['width'])
    assert np.isfinite(energy).all() and energy.min() >= 0
    assert abs(energy.sum(dtype=float) - 1) < 1e-6
    return energy.astype(float)


def raster_card(page, width, height):
    # Integrate black vector coverage on a white card in linear radiance.
    pix = page.get_pixmap(matrix=pymupdf.Matrix((2 * width - 1e-7) / page.rect.width,
                                               (2 * height - 1e-7) / page.rect.height),
                          colorspace=pymupdf.csGRAY, alpha=False)
    assert (pix.width, pix.height) == (2 * width, 2 * height)
    gray = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width)
    return gray.reshape(height, 2, width, 2).mean(axis=(1, 3)) / 255


def optical_layer(page, entry, energy, demand, density):
    angular_h = HEIGHT_MM * demand / 1000
    angular_w = angular_h * ASPECT
    cw, ch = max(1, round(angular_w * density)), max(1, round(angular_h * density))
    px, py = cw / angular_w, ch / angular_h
    # The existing independent area-overlap PSF sampler is used unchanged.
    # scaled_kernel converts its display pixels/tan(theta) to retinal pixels/mm
    # by dividing by this node's L. Do not divide/multiply by L a second time.
    kernel = scaled_kernel(energy, entry, 1., 1., px / 1000, py / 1000)
    card = raster_card(page, cw, ch)
    fg = fftconvolve(card, kernel, mode='full')
    alpha = np.clip(fftconvolve(np.ones_like(card), kernel, mode='full'), 0, 1)
    fg = np.clip(fg, 0, alpha)
    ry, rx = np.array(kernel.shape) // 2
    extent = [-angular_w / 2 - rx / px, angular_w / 2 + rx / px,
              -angular_h - ry / py, ry / py]
    kx=(np.arange(kernel.shape[1])-rx)/px
    ky=(np.arange(kernel.shape[0])-ry)/py
    centroid=[float(kernel.sum(axis=0)@kx),float(kernel.sum(axis=1)@ky)-angular_h/2]
    return fg, alpha, {'width': fg.shape[1], 'height': fg.shape[0],
                       'density': density, 'pixelsPerTanTheta': [px, py],
                       'extentTanTheta': extent, 'cardPixels': [cw, ch],
                       'cardExtentTanTheta': [-angular_w / 2, angular_w / 2, -angular_h, 0],
                       'kernelPixels': [kernel.shape[1], kernel.shape[0]],
                       'kernelEnergy': float(kernel.sum()),'expectedCoverageCentroidTanTheta':centroid}


def pack(fg, alpha):
    f = np.floor(fg * 4095 + .5).astype(np.uint16)
    a = np.floor(alpha * 4095 + .5).astype(np.uint16)
    rgb = np.stack((f >> 4, ((f & 15) << 4) | (a >> 8), a & 255), axis=-1).astype(np.uint8)
    decoded_f = ((rgb[:, :, 0].astype(np.uint16) << 4) | (rgb[:, :, 1] >> 4)) / 4095
    decoded_a = (((rgb[:, :, 1].astype(np.uint16) & 15) << 8) | rgb[:, :, 2]) / 4095
    error = max(np.max(abs(decoded_f - fg)), np.max(abs(decoded_a - alpha)))
    assert error <= .5 / 4095 + 1e-12
    return rgb, float(error)


def export_model(page, library, model, output, demands, densities):
    entries = []
    for demand in demands:
        source = next(e for e in library['entries'] if e['model'] == model and e['objectVergenceD'] == demand)
        energy = read_psf(source)
        node = {'objectVergenceD': demand, 'psfSha256': source['sha256'],
                'retinalMmPerTanTheta': source['retinalMmPerTanTheta'], 'levels': []}
        start = time.perf_counter()
        minimum = MINIMUM_DENSITIES.get(model, {}).get(round(demand * 10), DENSITIES[0])
        levels = densities or [density for density in DENSITIES if density >= minimum] or [minimum]
        for density in levels:
            fg, alpha, metadata = optical_layer(page, source, energy, demand, density)
            rgb, error = pack(fg, alpha)
            coverage=(((rgb[:,:,1].astype(np.uint16)&15)<<8)|rgb[:,:,2])/4095
            mass=coverage.sum();px,py=metadata['pixelsPerTanTheta'];x0,_,y0,_=metadata['extentTanTheta']
            centroid=[float(coverage.sum(axis=0)@(x0+(np.arange(coverage.shape[1])+.5)/px)/mass),
                      float(coverage.sum(axis=1)@(y0+(np.arange(coverage.shape[0])+.5)/py)/mass)]
            centroid_error=float(np.linalg.norm(np.asarray(centroid)-metadata['expectedCoverageCentroidTanTheta']))
            assert centroid_error < .05/min(px,py)
            metadata.update(coverageCentroidTanTheta=centroid,centroidErrorTanTheta=centroid_error,
                            coverageAreaRelativeError=float(mass/(metadata['cardPixels'][0]*metadata['cardPixels'][1])-1))
            name = f'{MODELS[model]}_{round(demand * 10):02d}_{density}.png'
            path = output / name
            Image.fromarray(rgb).save(path, optimize=True)
            rgba = np.concatenate((rgb, np.full((*rgb.shape[:2], 1), 255, np.uint8)), axis=2)
            metadata.update(file=name, bytes=path.stat().st_size, fileSha256=sha(path.read_bytes()),
                            decodedRgbaSha256=sha(rgba.tobytes()), maxLinearQuantizationError=error)
            node['levels'].append(metadata)
        entries.append(node)
        print(f'{model} {demand:.1f} D: {sum(x["bytes"] for x in node["levels"])} bytes, '
              f'{time.perf_counter() - start:.2f}s', flush=True)
    result = {'version': 1, 'model': model, 'identity': library['modelIdentities'][model], 'encoding': 'opaque-rgb-f12-a12',
              'coordinates': 'tan(theta), x right/y down; card bottom centre is (0,0)',
              'channels': 'R=f>>4; G=((f&15)<<4)|(a>>8); B=a&255; f,a in [0,4095]',
              'radiometry': 'linear photopic radiance, premultiplied foreground + coverage; no RGB gamma encoding',
              'physicalCardMm': [HEIGHT_MM * ASPECT, HEIGHT_MM],
              'cardSvgCanonicalSha256': sha((PUBLIC / 'reading-card.svg').read_text('utf8').replace('\r\n', '\n').encode()),
              'assumptions': 'existing frozen IOL model and PSFs; on-axis shift-invariant scalar-Y',
              'background': 'independent infinity PSF; never blur background with a near node',
              'software': {'pymupdf': pymupdf.VersionBind, 'numpy': np.__version__, 'scipy': scipy.__version__},
              'entries': entries}
    (output / f'{model}.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf8')
    print(f'Total PNG bytes: {sum(l["bytes"] for e in entries for l in e["levels"])}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=PUBLIC / 'optical-images')
    parser.add_argument('--models', nargs='+', choices=MODELS, default=list(MODELS))
    parser.add_argument('--demands', nargs='+', type=float, default=[i / 10 for i in range(10, 41)])
    parser.add_argument('--densities', nargs='+', type=int, help='Override release densities for an offline experiment')
    args = parser.parse_args()
    library = json.loads((PUBLIC / 'psf/manifest.json').read_text('utf8'))
    args.output.mkdir(parents=True, exist_ok=True)
    with pymupdf.open(PUBLIC / 'reading-card.svg') as doc:
        for model in args.models:
            export_model(doc[0], library, model, args.output, args.demands, args.densities)


if __name__ == '__main__':
    main()
