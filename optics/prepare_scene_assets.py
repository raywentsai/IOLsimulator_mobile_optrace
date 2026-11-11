"""Encode the generated streetscape as a full-size progressive JPEG."""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
args = parser.parse_args()
ROOT = Path(__file__).resolve().parents[1]
background = ROOT / 'src/lib/assets/images/background.jpg'
with Image.open(args.source) as source:
    assert source.size == (1024, 1536)
    source.convert('RGB').save(background, quality=92, subsampling=0, optimize=True, progressive=True)
with Image.open(background) as result:
    width, height = result.size
    samples = [[x, y, *result.getpixel((x, y))] for y in (0, height//2, height-1)
               for x in (0, width//2, width-1)]
metadata = {'width': width, 'height': height, 'bytes': background.stat().st_size,
            'fileSha256': hashlib.sha256(background.read_bytes()).hexdigest(), 'rgbSamples': samples,
            'source': 'Original synthetic streetscape generated with OpenAI image generation',
            'sourceSha256': hashlib.sha256(args.source.read_bytes()).hexdigest()}
background.with_suffix('.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf8')
print(metadata)
