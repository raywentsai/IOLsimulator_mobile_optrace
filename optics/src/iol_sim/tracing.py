"""Fixed-retina OPTrace tracing. Infinity uses truly collimated illumination."""
import numpy as np
import optrace as ot
from optrace.tracer import random as backend_random
from .eye import build_eye

def tracer(model, pupil, cornea, distance, use_hurb=True, pinhole=False, source_radius=3.5):
    g = distance if distance is not None else 100000.
    rt = ot.Raytracer(outline=[-max(60.,g*.002), max(60.,g*.002), -max(60.,g*.002), max(60.,g*.002), -max(g+1,10),30], use_hurb=use_hurb)
    eye, iol = build_eye(model, pupil, cornea)
    rt.add(eye)
    rt.add(ot.Detector(ot.RectangularSurface([4,4]), pos=[0,0,24.], desc='Fixed planar retina'))
    spectrum = ot.presets.light_spectrum.d65
    if pinhole:
        src = ot.RaySource(ot.CircularSurface(r=.0005*g), divergence='Isotropic', orientation='Converging',
                           conv_pos=[0,0,0], div_angle=float(np.rad2deg(np.arcsin(3.5/g))), pos=[0,0,-g], spectrum=spectrum)
    elif distance is None:
        src = ot.RaySource(ot.CircularSurface(r=3.5), pos=[0,0,-1.], divergence='None', spectrum=spectrum)
    else:
        src = ot.RaySource(ot.Point(), divergence='Lambertian', div_angle=float(np.rad2deg(np.arctan(source_radius/g))),
                           pos=[0,0,-g], spectrum=spectrum)
    rt.add(src)
    return rt, eye, iol

def trace_psf(model, pupil, cornea, distance, rays, seed, half_width=.25, use_hurb=True, pinhole=False, source_radius=3.5):
    ot.global_options.show_progress_bar = False
    # OPTrace has TWO independent RNGs: source SFC64 plus NumPy MT19937 for HURB.
    # Pinned backend exposes no public seeding API; reset its existing bit generator.
    # Single threading avoids nondeterministic consumption of the streams.
    ot.global_options.multithreading = False
    np.random.seed(seed)
    backend_random._random.bit_generator.state = np.random.SFC64(seed).state
    rt, eye, iol = tracer(model, pupil, cornea, distance, use_hurb, pinhole, source_radius)
    rt.trace(int(rays))
    extent = [-half_width,half_width,-half_width,half_width]
    psf = rt.detector_image(detector_index=1, extent=extent)
    # Obtain capture fraction from the same traced rays, no detector re-focus.
    wide = rt.detector_image(detector_index=1, extent=[-2,2,-2,2])
    return psf, {'captured_power_fraction': psf.power()/wide.power(),
                 'retina_z_mm': 24., 'paraxial_far_focus_z_mm': eye.tma().focal_points[1],
                 'eye_focal_length_mm': eye.tma().focal_lengths[1]}
