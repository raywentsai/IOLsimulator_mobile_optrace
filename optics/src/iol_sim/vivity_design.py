"""Measured radial-power informed refractive surface (not commercial recovery).

Measured NIMO departures constrain an integrated anterior sag. The original
patent posterior and the base spherical anterior remain explicit assumptions.
"""
import numpy as np
from scipy.interpolate import PchipInterpolator,CubicSpline
from scipy.integrate import cumulative_trapezoid
import optrace as ot

def profile_functions(params):
    radius=np.asarray(params['radius_mm'],float)
    power=np.asarray(params['departure_power_D'],float)*params.get('amplitude_scale',1.)
    interpolation=PchipInterpolator(radius,power,extrapolate=False)
    # Integrate only once on a fine radial grid. The interpolated derivative is
    # supplied analytically to OPTrace; units D=1/m require the factor 1000.
    grid=np.linspace(0,radius[-1],12001)
    slope=interpolation(grid)*grid/(1000*params['design_delta_n'])
    sag=cumulative_trapezoid(slope,grid,initial=0)
    sag_fn=CubicSpline(grid,sag,bc_type=((1,0.),(1,float(slope[-1]))))
    def delta_sag(r):return sag_fn(r)
    def delta_slope(r):return interpolation(r)*r/(1000*params['design_delta_n'])
    return delta_sag,delta_slope

def make_surface(params,radius):
    R=params['R_mm'];delta,derivative=profile_functions(params)
    correction=params.get('base_power_offset_D',0.)/(1000*params['design_delta_n'])
    # Optional v2.1 BASE-SA correction, deliberately separate from the frozen
    # measured central departure. a4 [mm^-3] * r^4 [mm^4] is sag [mm].
    quartic=params.get('base_quartic_coefficient_mm_inv3',0.)
    def sag(r):
        value=r*r/(R*(1+np.sqrt(1-(r/R)**2)))+delta(r)+correction*r*r/2
        return value+quartic*r**4 if quartic else value
    def slope(r):
        value=r/np.sqrt(R*R-r*r)+derivative(r)+correction*r
        return value+4*quartic*r**3 if quartic else value
    roc=1/(1/R+params['departure_power_D'][0]*params.get('amplitude_scale',1.)/(1000*params['design_delta_n'])+correction)
    return ot.FunctionSurface1D(r=radius,func=sag,deriv_func=slope,parax_roc=roc)
