"""Lossless transport copy; preserve every source RGB pixel and dimensions."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
source = root / 'src/lib/assets/images/background.png'
target = source.with_name('background.lossless.webp')
with Image.open(source) as image:
    image.save(target, format='WEBP', lossless=True, exact=True, method=6)
    with Image.open(target) as decoded:
        assert decoded.size == image.size and decoded.convert('RGB').tobytes() == image.convert('RGB').tobytes()
print(f'{source.stat().st_size} -> {target.stat().st_size} bytes; RGB identical')
