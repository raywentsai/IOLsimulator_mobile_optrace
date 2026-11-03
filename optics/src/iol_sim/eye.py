"""Arizona pseudophakic eye and explicitly labelled corneal geometry variants."""
import optrace as ot
from .config import read_model
from .geometry import make_iol

def build_eye(model, pupil, cornea='average'):
    cfg = read_model('eye')
    eye = ot.presets.geometry.arizona_eye(pupil=pupil)
    vitreous = eye.lenses[1].n2
    eye.remove(eye.lenses[1])
    if cornea != 'arizona':
        old = eye.lenses[0]
        front = ot.ConicSurface(r=5.45, R=cfg['cornea_anterior_R_mm'], k=cfg['corneas'][cornea]['anterior_k'])
        back = ot.ConicSurface(r=5.45, R=cfg['cornea_posterior_R_mm'], k=cfg['cornea_posterior_k'])
        replacement = ot.Lens(front, back, d1=0, d2=cfg['corneal_thickness_mm'], pos=[0,0,0], n=old.n, n2=old.n2)
        eye.remove(old)
        eye.add(replacement)
    iol = make_iol(model, vitreous, cfg['iol_front_z_mm'])
    eye.add(iol)
    return eye, iol
