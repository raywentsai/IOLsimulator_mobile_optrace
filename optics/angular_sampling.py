"""Linear-light pixel-area integration of a sampled angular radiance field."""
import numpy as np
from scipy.sparse import csr_matrix


def weights(count, origin, pitch, source_count, source_origin, source_pitch):
    # Conservative cell-overlap integration of stored pixel averages.
    # At an identical grid this is the identity, including all PSF tails.
    rows, cols, values = [], [], []
    for i in range(count):
        lo = (origin + i / pitch - source_origin) * source_pitch
        hi = lo + source_pitch / pitch
        for j in range(max(0, int(np.floor(lo))), min(source_count, int(np.ceil(hi)))):
            value = max(0, min(hi, j + 1) - max(lo, j)) / (hi - lo)
            if value > 0:
                rows.append(i); cols.append(j); values.append(value)
    return csr_matrix((values, (rows, cols)), shape=(count, source_count))


def resample(layer, metadata, target):
    sx, sy = metadata['pixelsPerTanTheta']
    tx, ty = target['pixelsPerTanTheta']
    x0, _, y0, _ = target['extentTanTheta']
    source_x0, _, source_y0, _ = metadata['extentTanTheta']
    wx = weights(target['width'], x0, tx, metadata['width'], source_x0, sx)
    wy = weights(target['height'], y0, ty, metadata['height'], source_y0, sy)
    return (wy @ layer) @ wx.T
