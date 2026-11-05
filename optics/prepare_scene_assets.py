"""Lossless scene PNG repacking; favicon-only downsize (never optical data)."""
import hashlib
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
background = ROOT / 'src/lib/assets/images/background.png'
with Image.open(background) as source:
    source.load()
    assert source.mode == 'RGB'
    pixels = source.tobytes()
    shape = source.size
    source.save(background, optimize=True, compress_level=9)
with Image.open(background) as result:
    assert result.size == shape and result.mode == 'RGB' and result.tobytes() == pixels
metadata = {'width': shape[0], 'height': shape[1], 'bytes': background.stat().st_size,
            'fileSha256': hashlib.sha256(background.read_bytes()).hexdigest(),
            'rgbSha256': hashlib.sha256(pixels).hexdigest()}
background.with_suffix('.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf8')
favicon = ROOT / 'static/favicon.png'
with Image.open(favicon) as source:
    source.thumbnail((64, 64), Image.Resampling.LANCZOS)
    source.save(favicon, optimize=True)
print(metadata, 'favicon bytes', favicon.stat().st_size)
