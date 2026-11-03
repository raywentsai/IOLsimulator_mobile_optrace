"""IOL surfaces; optical calculations delegated to OPTrace."""
import numpy as np
import optrace as ot

def smooth_add_sag(r, peak_add_D, peak_radius_mm, design_delta_n):
    """Integrated small-angle sagittal surface-power add; mm, no phase wrapping.

    delta_F(r) = peak_add_D * e * u * exp(-u), u = (r/s)^2.
    Delta sag begins at r^4: nominal paraxial power remains unchanged.
    This is a design relation, not a claim of exact thick-eye effective add.
    """
    s2 = peak_radius_mm**2
    u = np.asarray(r)**2 / s2
    return peak_add_D*np.e*s2/(2000*design_delta_n)*(-np.expm1(-u)-u*np.exp(-u))

def surface(params, radius):
    if params['type'] == 'quadratic_sag_correction':
        from .distance_correction import corrected_surface
        return corrected_surface(params, radius)
    kind, R = params['type'], params['R_mm']
    if kind == 'vivity_measured_profile':
        from .vivity_design import make_surface
        return make_surface(params,radius)
    if kind == 'spherical':
        return ot.SphericalSurface(r=radius, R=R)
    if kind == 'aspheric':
        return ot.AsphericSurface(r=radius, R=R, k=params['k'], coeff=params['coeff'])
    if kind == 'smooth_power_add':
        args = {k: params[k] for k in ('peak_add_D', 'peak_radius_mm', 'design_delta_n')}
        def sag(r):
            return r*r/(R*(1+np.sqrt(1-(r/R)**2))) + smooth_add_sag(r, **args)
        def deriv(r):
            u = (r/args['peak_radius_mm'])**2
            return r/np.sqrt(R*R-r*r) + args['peak_add_D']*np.e/(1000*args['design_delta_n'])*r*u*np.exp(-u)
        return ot.FunctionSurface1D(r=radius, func=sag, deriv_func=deriv, parax_roc=R)
    raise ValueError(f'Unknown surface type: {kind}')

def make_iol(model, vitreous, z):
    material = model['material']
    index = ot.RefractionIndex('Abbe', n=material['n'], V=material['V'], lines=ot.presets.spectral_lines.FdC)
    radius = model['optical_diameter_mm']/2
    return ot.Lens(surface(model['front'], radius), surface(model['back'], radius),
                   d1=0, d2=model['thickness_mm'], pos=[0, 0, z], n=index, n2=vitreous, desc=model['label'])
