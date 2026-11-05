"""Small compressed inputs/oracles for identical-input image-vs-FFT checks."""
import gzip
import hashlib
import json
import numpy as np
import pymupdf
from export_optical_images import PUBLIC, MODEL, read_psf, optical_layer, raster_card
from validate_library import encode, decode


def main():
    psfs=json.loads((PUBLIC/'psf/manifest.json').read_text('utf8'))
    library=json.loads((PUBLIC/'optical-images/manifest.json').read_text('utf8'))
    doc=pymupdf.open(PUBLIC/'reading-card.svg')
    target=PUBLIC/'validation'
    cases=[]
    for demand in [1.,2.5,4.]:
        node=next(e for e in library['entries'] if e['objectVergenceD']==demand)
        near=next(e for e in psfs['entries'] if e['model']==MODEL and e['objectVergenceD']==demand)
        infinity=next(e for e in psfs['entries'] if e['model']==MODEL and e['objectVergenceD']==0)
        level=next(e for e in node['levels'] if e['density']==4096)
        fg,alpha,metadata=optical_layer(doc[0],near,read_psf(near),demand,4096)
        cw,ch=level['cardPixels'];width,height=level['width'],level['height']
        card=raster_card(doc[0],cw,ch).astype('<f4')
        # Existing dynamic renderer anchors the card at the screen bottom;
        # the lower PSF tail falls below the viewport, identically in both paths.
        ry=(height-ch)//2
        output=np.empty((height,width,4),np.uint8)
        bg=np.asarray(decode([38,112,207]),dtype=np.float32)
        radiance=np.zeros((height,width),np.float32)
        coverage=np.zeros_like(radiance)
        radiance[ry:]=fg[:height-ry].astype('float32')
        coverage[ry:]=alpha[:height-ry].astype('float32')
        output[:,:,:3]=encode(radiance[:,:,None]+(1-coverage[:,:,None])*bg)
        output[:,:,3]=255
        card_name=f'optical-card-{round(demand*10):02d}.card'
        expected_name=f'optical-scene-{round(demand*10):02d}.ref'
        (target/card_name).write_bytes(gzip.compress(card.tobytes(),mtime=0))
        (target/expected_name).write_bytes(gzip.compress(output.tobytes(),mtime=0))
        cases.append({'name':f'Aspheric optical image {demand:.1f} D','width':width,'height':height,
            'cardWidth':cw,'cardHeight':ch,'cardFile':card_name,'expectedFile':expected_name,
            'cardSha256':hashlib.sha256(card.tobytes()).hexdigest(),
            'expectedSha256':hashlib.sha256(output.tobytes()).hexdigest(),
            'near':near,'infinity':infinity,'level':level,
            'cssPxPerMm':1.,'viewingDistanceM':1.,'renderScale':metadata['pixelsPerTanTheta'][0]/1000,
            'renderScaleY':metadata['pixelsPerTanTheta'][1]/1000,
            'background':[38,112,207,255],'backgroundWidth':1,'backgroundHeight':1})
    (target/'optical-image-reference.json').write_text(json.dumps({'cases':cases},indent=2)+'\n',encoding='utf8')
    print('Exported 3 canonical, identical-input dynamic/precomputed SciPy fixtures.')


if __name__=='__main__':main()
