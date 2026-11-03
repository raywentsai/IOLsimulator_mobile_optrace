"""Public-domain vector ETDRS crop reused from offline_rendering_v3.1."""
import argparse
import xml.etree.ElementTree as ET
from pathlib import Path
from iol_sim.config import ROOT, sha256, write_json

def export(reference: Path):
    source=reference/'outputs/offline_rendering_v3_1/sources/ETDRS_Chart_2.svg'
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    ET.register_namespace('xlink','http://www.w3.org/1999/xlink')
    root=ET.parse(source).getroot()
    # Original SVG uses millimetres in its viewBox; v3.1 crop is in PDF points.
    x0,y0,x1,y1=[v*25.4/72 for v in (150,175,1678,1345)]
    root.set('viewBox',f'{x0} {y0} {x1-x0} {y1-y0}')
    root.set('width','1528');root.set('height','1170')
    root.set('preserveAspectRatio','none')
    root.insert(0,ET.Element('{http://www.w3.org/2000/svg}rect',{'x':str(x0),'y':str(y0),'width':str(x1-x0),'height':str(y1-y0),'fill':'white'}))
    dest=ROOT.parent/'static/reading-card.svg'
    ET.ElementTree(root).write(dest,encoding='utf-8',xml_declaration=True)
    write_json(ROOT.parent/'static/reading-card.json',{
        'source':'https://commons.wikimedia.org/wiki/File:ETDRS_Chart_2.svg',
        'license':'public domain', 'sourceSha256':sha256(source), 'assetSha256':sha256(dest),
        'aspect':1528/1170, 'objectHeightMm':28.,
        'cropPoints':[150,175,1678,1345],
        'letterHeightsMm':[v*28/1170 for v in [164.91978454589844,131.32501220703125,103.83837890625,82.45989990234375,65.376220703125,51.919189453125,41.22998046875]],
        'angularRule':'2 atan(letterHeightMm * objectVergenceD / 2000); physical display size = object size * actual viewing distance / simulated object distance',
        'status':'ETDRS-style illustrative card, not a validated acuity test; source labels are cropped out'})

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('reference',type=Path)
    export(parser.parse_args().reference)
