"""Small compressed inputs/oracles for identical-input image-vs-FFT checks."""
import gzip
import hashlib
import json
import numpy as np
import pymupdf
from export_optical_images import PUBLIC, MODELS, read_psf, optical_layer, raster_card, covers_output
from angular_sampling import resample
from validate_library import encode, decode


def model_fixtures(page, psfs, model):
    library=json.loads((PUBLIC/f'optical-images/{model}.json').read_text('utf8'))
    target=PUBLIC/'validation'
    cases=[]
    for demand in [1.,2.5,4.]:
        node=next(e for e in library['entries'] if e['objectVergenceD']==demand)
        near=next(e for e in psfs['entries'] if e['model']==model and e['objectVergenceD']==demand)
        infinity=next(e for e in psfs['entries'] if e['model']==model and e['objectVergenceD']==0)
        energy=read_psf(near)
        fg,alpha,metadata=optical_layer(page,near,energy,demand,4096)
        level=next(level for level in node['levels'] if covers_output(level, metadata['pixelsPerTanTheta']))
        compare_dynamic=level['density']==metadata['density']
        if not compare_dynamic:
            # Validate browser resampling against the dense, unquantized oracle.
            dense_f,dense_a,dense_grid=optical_layer(page,near,energy,demand,16384)
            fg=resample(dense_f,dense_grid,metadata)
            alpha=resample(dense_a,dense_grid,metadata)
        cw,ch=metadata['cardPixels'];width,height=metadata['width'],metadata['height']
        card=raster_card(page,cw,ch).astype('<f4')
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
        # Exercise the real viewport crop while keeping the card raster and
        # angular coordinates intact. The GPU background must fit its cache.
        view_width,view_height=min(width,560),min(height,560)
        left=(width-cw+1)//2-(view_width-cw+1)//2
        output=output[height-view_height:,left:left+view_width]
        width,height=view_width,view_height
        tag=f'{MODELS[model]}-{round(demand*10):02d}'
        card_name=f'optical-card-{tag}.card'
        expected_name=f'optical-scene-{tag}.ref'
        (target/card_name).write_bytes(gzip.compress(card.tobytes(),mtime=0))
        (target/expected_name).write_bytes(gzip.compress(output.tobytes(),mtime=0))
        cases.append({'name':f'{MODELS[model].capitalize()} optical image {demand:.1f} D','width':width,'height':height,
            'cardWidth':cw,'cardHeight':ch,'cardFile':card_name,'expectedFile':expected_name,
            'cardSha256':hashlib.sha256(card.tobytes()).hexdigest(),
            'expectedSha256':hashlib.sha256(output.tobytes()).hexdigest(),
            'near':near,'infinity':infinity,'level':level,'compareDynamic':compare_dynamic,
            'cssPxPerMm':1.,'viewingDistanceM':1.,'renderScale':metadata['pixelsPerTanTheta'][0]/1000,
            'renderScaleY':metadata['pixelsPerTanTheta'][1]/1000,
            'background':[38,112,207,255],'backgroundWidth':1,'backgroundHeight':1})
    return cases


def main():
    psfs=json.loads((PUBLIC/'psf/manifest.json').read_text('utf8'))
    with pymupdf.open(PUBLIC/'reading-card.svg') as doc:
        cases=[case for model in MODELS for case in model_fixtures(doc[0], psfs, model)]
    (PUBLIC/'validation/optical-image-reference.json').write_text(json.dumps({'cases':cases},indent=2)+'\n',encoding='utf8')
    print(f'Exported {len(cases)} canonical SciPy scene fixtures.')


if __name__=='__main__':main()
