"""Reproducible optrace library export; original research is read-only.

Run: uv run --project optics python optics/export_psfs.py --reference PATH
Every exported vergence is traced directly (never extrapolated/interpolated).
Resume authenticates cached inputs; a worker has a strict 120-second deadline.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import multiprocessing as mp
import importlib.metadata
import platform
from pathlib import Path
import time

import numpy as np
from scipy.sparse import csr_matrix
from iol_sim.config import ROOT, read_model, sha256, write_json

MODELS = ('spherical_monofocal_dc_v1', 'aspheric_monofocal_dc_v1', 'vivity_inspired_v2_1_dc_v1')
DEMANDS = (0., *[i / 10 for i in range(10, 41)])
RAYS, SEED, SIZE = 1500000, 28106701, 513
BACKEND = ('geometry', 'eye', 'tracing', 'vivity_design', 'distance_correction', 'config', 'psf')
OUT = ROOT.parent / 'static' / 'psf'
CACHE = ROOT / 'outputs' / 'native'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sources():
    return {f'src/iol_sim/{name}.py': sha256(ROOT / f'src/iol_sim/{name}.py') for name in BACKEND}


def resample_energy(kernel, size=SIZE):
    """Integrated source bins -> integrated target bins, retaining all 2D flux."""
    def weights(n):
        a, b = np.linspace(0, 1, n + 1), np.linspace(0, 1, size + 1)
        return csr_matrix(np.maximum(0, np.minimum(b[1:, None], a[None, 1:]) - np.maximum(b[:-1, None], a[None, :-1])) * n)
    wy, wx = weights(kernel.shape[0]), weights(kernel.shape[1])
    output = (wx @ (wy @ kernel).T).T
    np.testing.assert_allclose(output.sum(), kernel.sum(), atol=2e-12)
    return output


def projection_mm(model, demand):
    from iol_sim.eye import build_eye
    eye, _ = build_eye(read_model(model), 3., 'average')
    # Same fixed-retina chief-ray projection as offline v3.1 chart_projection.
    g = 1e9 if demand == 0 else 1000 / demand
    tma = eye.tma()
    mr, mpupil = tma.matrix_at(-g, 24.), tma.matrix_at(-g, 3.519999999)
    m = float(mr[0, 0] - mr[0, 1] * mpupil[0, 0] / mpupil[0, 1])
    return abs(m * g)


def worker(model, demand, destination):
    from iol_sim.tracing import trace_psf
    start = time.monotonic()
    psf, info = trace_psf(read_model(model), 3., 'average', None if demand == 0 else 1000 / demand, RAYS, SEED)
    energy = psf.data[:, :, 1].astype(np.float64)
    energy /= energy.sum()
    np.savez_compressed(destination, kernel=energy, capture=info['captured_power_fraction'])
    write_json(Path(destination).with_suffix('.json'), {'seconds': time.monotonic()-start,
        'model_sha256': sha256(ROOT / f'models/{model}.json'), 'eye_sha256': sha256(ROOT / 'models/eye.json'),
        'backend': sources(), 'rays': RAYS, 'seed': SEED, 'file_sha256': sha256(destination)})


def native(model, demand, reference):
    name = f'{model}_{demand:.1f}'
    dest = CACHE / f'{name}.npz'
    if reference:
        src = reference / 'outputs/defocus_sweep_dc_v2' / model / f'demand_{demand:g}D'
        if (src / 'record.json').exists():
            record = json.loads((src / 'record.json').read_text(encoding='utf8'))
            assert record['model_sha256'] == sha256(ROOT / f'models/{model}.json')
            assert record['eye_sha256'] == sha256(ROOT / 'models/eye.json')
            assert record['backend'] == sources()
            assert record['pupil_mm'] == 3 and record['cornea'] == 'average'
            assert record['rays'] == RAYS and record['seed'] == SEED and record['demand_D'] == demand
            assert sha256(src / 'psf.npz') == record['hashes']['psf.npz']
            with np.load(src / 'psf.npz') as a:
                return a['photopic_kernel'], record['capture'], 'authenticated_reference', record['hashes']['psf.npz']
    if not dest.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        process = mp.Process(target=worker, args=(model, demand, str(dest)))
        process.start()
        process.join(120)
        if process.is_alive():
            process.terminate()
            process.join()
            raise TimeoutError(f'{name}: tracing exceeded 120 seconds; stopped without retry')
        if process.exitcode != 0:
            raise RuntimeError(f'{name}: tracing worker failed; stopped without retry')
    record = json.loads(dest.with_suffix('.json').read_text(encoding='utf8'))
    assert record['model_sha256'] == sha256(ROOT / f'models/{model}.json')
    assert record['eye_sha256'] == sha256(ROOT / 'models/eye.json') and record['backend'] == sources()
    assert record['file_sha256'] == sha256(dest) and record['rays'] == RAYS and record['seed'] == SEED
    with np.load(dest) as a:
        return a['kernel'], float(a['capture']), 'direct_trace', record['file_sha256']


def export(reference=None, only=None):
    OUT.mkdir(parents=True, exist_ok=True)
    entries = []
    jobs = [(n, d) for n in MODELS for d in DEMANDS]
    if only:
        jobs = [(MODELS[0], 4.)]
    for model, demand in jobs:
        start = time.monotonic()
        kernel, capture, origin, source_hash = native(model, demand, reference)
        assert kernel.shape == (945, 945) and np.isfinite(kernel).all() and kernel.min() >= 0
        assert capture > .99, f'{model}/{demand}: insufficient PSF capture {capture}; stop'
        np.testing.assert_allclose(kernel.sum(), 1, atol=1e-12)
        # Native detector y increases upwards; display y down + optical inversion = x flip only.
        energy = resample_energy(np.fliplr(kernel))
        data = energy.astype('<f4').tobytes()
        name = f'{model}_{round(demand*10):02d}.psf'
        (OUT / name).write_bytes(gzip.compress(data, mtime=0))
        entry = {'model': model, 'objectVergenceD': demand, 'file': name, 'width': SIZE, 'height': SIZE,
                 'center': [(SIZE-1)/2, (SIZE-1)/2], 'retinalExtentMm': [-.25,.25,-.25,.25],
                 'retinalMmPerTanTheta': projection_mm(model, demand), 'sum': float(np.frombuffer(data, '<f4').sum(dtype=np.float64)),
                 'captureFraction': capture, 'sha256': digest(data), 'sourceSha256': source_hash, 'origin': origin}
        entries.append(entry)
        print(f'{len(entries)}/{len(jobs)} {model} {demand:g}D {origin} {time.monotonic()-start:.1f}s', flush=True)
    if only:
        return
    assert len(entries) == 96
    write_json(OUT / 'manifest.json', {'version': 1, 'encoding': 'gzip little-endian float32 integrated bin energy, row-major',
        'orientation': 'upright display x-right/y-down; optical inversion included; no centroid recentering',
        'captureFractionDefinition': 'radiant W in +/-0.25 mm divided by radiant W in the 4x4 mm reference detector; photopic Y is normalized separately within the exported window',
        'pupilMm': 3., 'cornea': 'average', 'spectrum': 'D65 380-780 nm; photopic Y; dispersive FdC materials',
        'rays': RAYS, 'seed': SEED, 'diffraction': 'optrace HURB approximation, not full wave optics',
        'backendCommit': 'adad608acedb08c2d99688613fa01034865c9d47', 'backendSources': sources(),
        'software': {'python':platform.python_version(), **{p:importlib.metadata.version(p) for p in ('optrace','numpy','scipy')}},
        'modelIdentities': json.loads((ROOT.parent / 'src/lib/data/physics-models.json').read_text('utf8')),
        'models': {n: read_model(n) for n in MODELS}, 'eye': read_model('eye'), 'entries': entries})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--benchmark', action='store_true')
    args = parser.parse_args()
    export(args.reference, args.benchmark)
