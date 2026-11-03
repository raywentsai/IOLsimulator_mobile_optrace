"""Fixed quadratic sag correction, preserving the existing surface backend.

The coefficient has units mm^-1. Delta sag=a2*r^2 [mm] and its radial
derivative=2*a2*r are traced by OPTrace as a real refracting surface.
Calibration wavelength and delta power are provenance stored in model JSON;
the geometric coefficient stays fixed while refractive indices disperse.
"""
import numpy as np
import optrace as ot


def corrected_surface(params, radius):
    from .geometry import surface

    base = surface(params['base_surface'], radius)
    if not base.rotational_symmetry or base.parax_roc is None:
        raise ValueError('Quadratic correction requires an axisymmetric surface with known vertex curvature')
    a2 = float(params['quadratic_sag_coefficient_mm_inv'])
    if not np.isfinite(a2):
        raise ValueError('Quadratic sag coefficient must be finite')

    def sag(r):
        return base.values(r, np.zeros_like(r)) + a2*r*r

    def slope(r):
        normals = base.normals(r, np.zeros_like(r))
        return -normals[:, 0]/normals[:, 2] + 2*a2*r

    curvature = 1/base.parax_roc + 2*a2
    return ot.FunctionSurface1D(r=radius, func=sag, deriv_func=slope,
                               parax_roc=np.inf if curvature == 0 else 1/curvature)
