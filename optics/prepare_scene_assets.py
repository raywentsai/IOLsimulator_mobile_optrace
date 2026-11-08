"""Encode the original scene photo as a full-size progressive JPEG."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
background = ROOT / 'src/lib/assets/images/background.jpg'
source_bytes = subprocess.check_output(
    ['git', 'show', 'c28d540997447c9e588048a5b8131a54c5a39a23:src/lib/assets/images/background.png'], cwd=ROOT)
with Image.open(io.BytesIO(source_bytes)) as source:
    assert source.mode == 'RGB' and source.size == (1024, 1536)
    source.save(background, quality=95, subsampling=0, optimize=True, progressive=True)
with Image.open(background) as result:
    width, height = result.size
    samples = [[x, y, *result.getpixel((x, y))] for y in (0, height//2, height-1)
               for x in (0, width//2, width-1)]
metadata = {'width': width, 'height': height, 'bytes': background.stat().st_size,
            'fileSha256': hashlib.sha256(background.read_bytes()).hexdigest(), 'rgbSamples': samples}
background.with_suffix('.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf8')
print(metadata)
