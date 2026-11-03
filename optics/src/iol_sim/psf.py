"""Energy normalization and sampled, photopic OTF/MTF diagnostics."""
import numpy as np

def normalized_psf(psf):
    raw = psf.data
    if not np.isfinite(raw).all() or raw[:,:,1].sum() <= 0 or raw[:,:,3].sum() <= 0:
        raise ValueError('Invalid or empty PSF')
    return raw[:,:,1]/raw[:,:,1].sum(), raw[:,:,3]/raw[:,:,3].sum()

def metrics(kernel, extent):
    ny,nx = kernel.shape
    dx,dy = (extent[1]-extent[0])/nx, (extent[3]-extent[2])/ny
    x = extent[0]+(np.arange(nx)+.5)*dx
    y = extent[2]+(np.arange(ny)+.5)*dy
    cx,cy = float(kernel.sum(axis=0)@x), float(kernel.sum(axis=1)@y)
    r = np.hypot(x[None,:]-cx,y[:,None]-cy)
    nz = kernel > 0
    radii,weights = r[nz],kernel[nz]
    order = np.argsort(radii)
    cdf = np.cumsum(weights[order])
    otf = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(kernel)))
    mtf = np.abs(otf)/np.abs(otf[ny//2,nx//2])
    fx = np.fft.fftshift(np.fft.fftfreq(nx,dx))[nx//2:]
    fy = np.fft.fftshift(np.fft.fftfreq(ny,dy))[ny//2:]
    mx,my = mtf[ny//2,nx//2:],mtf[ny//2:,nx//2]
    info = {'centroid_mm':[cx,cy], 'r50_um':float(np.interp(.5,cdf,radii[order])*1000),
            'r80_um':float(np.interp(.8,cdf,radii[order])*1000),
            'EE_10um':float(kernel[r<=.01].sum()), 'EE_25um':float(kernel[r<=.025].sum()),
            'MTF50_lpmm':float((np.interp(50,fx,mx)+np.interp(50,fy,my))/2),
            'dx_mm':dx,'dy_mm':dy, 'sum':float(kernel.sum())}
    return info, {'frequency_lpmm':fx, 'mtf_x':mx,'mtf_y':my}

def save_psf(path, psf):
    y,w = normalized_psf(psf)
    info,curves = metrics(y,psf.extent)
    np.savez_compressed(path, photopic_kernel=y, radiant_kernel=w, extent_mm=psf.extent,
                        pixel_pitch_mm=[info['dx_mm'],info['dy_mm']], **curves)
    return info
