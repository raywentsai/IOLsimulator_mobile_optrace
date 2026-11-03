"""Independent SciPy oracle for browser physical sampling and scene rendering."""
import gzip
import json
import platform
from pathlib import Path
import numpy as np
from scipy.signal import fftconvolve
import scipy
from iol_sim.config import ROOT, write_json
from export_psfs import MODELS, DEMANDS, digest

PUBLIC=ROOT.parent/'static'

def scaled_kernel(energy,entry,ppm,distance,scale,scale_y):
    ex=entry['retinalExtentMm'];l=entry['retinalMmPerTanTheta']
    px,py=ppm*distance*1000*scale/l,ppm*distance*1000*scale_y/l
    def weights(n,lo,hi,pitch):
        edges=np.linspace(lo,hi,n+1)*pitch
        r=int(np.ceil(max(abs(edges[0]),abs(edges[-1]))+.5))
        centres=np.arange(-r,r+1)
        overlap=np.maximum(0,np.minimum(centres[:,None]+.5,edges[None,1:])-np.maximum(centres[:,None]-.5,edges[None,:-1]))
        return overlap/np.diff(edges)[None,:]
    wx=weights(entry['width'],ex[0],ex[1],px);wy=weights(entry['height'],ex[2],ex[3],py)
    out=wy@energy@wx.T
    assert abs(out.sum()-1)<1e-5
    return out/out.sum()

def convolve(image,kernel,mode='reflect'):
    ry,rx=np.array(kernel.shape)//2
    padded=np.pad(image,((ry,ry),(rx,rx)),mode=mode)
    return fftconvolve(padded,kernel,mode='valid').astype('float32')

def decode(x):
    x=np.asarray(x,dtype=float)/255
    return np.where(x<=.04045,x/12.92,((x+.055)/1.055)**2.4)

def encode(x):
    x=np.clip(x,0,1)
    return np.floor(np.where(x<=.0031308,12.92*x,1.055*x**(1/2.4)-.055)*255+.5).astype('uint8')

def fixture(model,entries,read_energy,index):
    near=next(e for e in entries if e['model']==model and e['objectVergenceD']==4)
    far=next(e for e in entries if e['model']==model and e['objectVergenceD']==0)
    width,height=32,24;cw,ch=11,9
    # Deliberately different channel patterns expose gamma errors or channel swaps.
    y,x=np.mgrid[:height,:width]
    bg=np.stack(((17*x+13*y)%256,(5*x+29*y+31)%256,(47*x+3*y+99)%256,np.full_like(x,255)),axis=2).astype('uint8')
    cy,cx=np.mgrid[:ch,:cw];card=((cx+2*cy)%4==0).astype('float32')
    ppm,distance,scale,sy=[(3.,.2,.5,.5),(5.,.4,.25,.3),(7.,.5,.5,.5)][index]
    nk=scaled_kernel(read_energy(near),near,ppm,distance,scale,sy)
    bk=scaled_kernel(read_energy(far),far,ppm,distance,scale,sy)
    background=np.stack([convolve(decode(bg[:,:,c]),bk) for c in range(3)],axis=2)
    ry,rx=np.array(nk.shape)//2
    mask=np.pad(np.ones_like(card),((ry,ry),(rx,rx)))
    radiance=np.pad(card,((ry,ry),(rx,rx)))
    fg=convolve(radiance,nk,'constant');alpha=convolve(mask,nk,'constant')
    left=int(np.floor((width-cw)/2+.5))-rx;top=height-ch-ry
    final=background.copy()
    for yy in range(height):
        for xx in range(width):
            px,py=xx-left,yy-top
            if 0<=px<mask.shape[1] and 0<=py<mask.shape[0]:
                a=np.clip(alpha[py,px],0,1);f=np.clip(fg[py,px],0,a)
                final[yy,xx]=f+(1-a)*background[yy,xx]
    rgba=np.concatenate((encode(final),np.full((height,width,1),255,dtype='uint8')),axis=2)
    return {'name':model,'width':width,'height':height,'backgroundWidth':width,'backgroundHeight':height,
        'background':bg.ravel().tolist(),'card':card.ravel().tolist(),'cardWidth':cw,'cardHeight':ch,
        'near':near,'infinity':far,'cssPxPerMm':ppm,'viewingDistanceM':distance,'renderScale':scale,'renderScaleY':sy,
        'expectedRgba':rgba.ravel().tolist(),'expectedScaledKernel':nk.ravel().tolist(),
        'kernelWidth':nk.shape[1],'kernelHeight':nk.shape[0]}

def main():
    manifest=json.loads((PUBLIC/'psf/manifest.json').read_text(encoding='utf8'))
    entries=manifest['entries'];assert len(entries)==96
    def read_energy(entry):
        data=gzip.decompress((PUBLIC/'psf'/entry['file']).read_bytes())
        assert digest(data)==entry['sha256']
        a=np.frombuffer(data,'<f4').reshape(entry['height'],entry['width'])
        assert np.isfinite(a).all() and a.min()>=0 and abs(a.sum(dtype=float)-1)<1e-6
        assert entry['captureFraction']>.99
        return a.astype(float)
    for model in MODELS:
        assert sorted(e['objectVergenceD'] for e in entries if e['model']==model)==list(DEMANDS)
    for entry in entries:read_energy(entry)
    fixtures=[fixture(model,entries,read_energy,i) for i,model in enumerate(MODELS)]
    write_json(PUBLIC/'validation/psf-reference.json',{'generator':'Python SciPy fftconvolve; reflect background; zero-padded premultiplied foreground; linear light',
        'versions':{'python':platform.python_version(),'numpy':np.__version__,'scipy':scipy.__version__},'cases':fixtures})
    write_json(ROOT/'outputs/library-validation.json',{'passed':True,'entries':len(entries),'minCapture':min(e['captureFraction'] for e in entries),
        'maxEnergyError':max(abs(read_energy(e).sum()-1) for e in entries),'fixtures':len(fixtures)})
    print('PASS: 96 authenticated, normalized PSFs; 3 independent SciPy scene fixtures exported.')

if __name__=='__main__':main()
