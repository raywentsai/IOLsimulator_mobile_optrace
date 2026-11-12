"""Create the fictional ID-1 credit card as font-independent SVG outlines."""
import argparse
import hashlib
import json
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

PUBLIC = Path(__file__).resolve().parents[1] / 'static'
WIDTH, HEIGHT = 85.60, 53.98


def outline(font, text, center, baseline, cap_height):
    glyphs, cmap, metrics = font.getGlyphSet(), font.getBestCmap(), font['hmtx'].metrics
    names = [cmap[ord(char)] for char in text]
    bounds = BoundsPen(glyphs)
    glyphs[cmap[ord('H')]].draw(bounds)
    scale = cap_height / bounds.bounds[3]
    x = center - scale * sum(metrics[name][0] for name in names) / 2
    paths = []
    for name in names:
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        if pen.getCommands():
            paths.append(f'<path transform="translate({x:.5f} {baseline}) scale({scale:.8f} {-scale:.8f})" d="{pen.getCommands()}"/>')
        x += scale * metrics[name][0]
    return ''.join(paths)


def main(font_dir):
    regular, bold = (TTFont(font_dir / f'AtkinsonHyperlegible-{weight}.ttf') for weight in ('Regular', 'Bold'))
    artwork = [
        '<rect width="85.6" height="53.98" fill="#fff"/>',
        '<rect x=".4" y=".4" width="84.8" height="53.18" rx="3.18" fill="none" stroke="#000" stroke-width=".24"/>',
        # Keep a word break at the comparison line without changing cap heights.
        outline(bold, 'BANK OF', 31.3, 9.8, 3.1),
        outline(bold, 'CATARACT', 56.3, 9.8, 3.1),
        outline(regular, 'CREDIT', 76.1, 9.8, 1.6),
        # Contact chip and its etched pads. The chip sits just inside the
        # central field so it remains visible at close distances on phones.
        '<g fill="none" stroke="#000" stroke-width=".33">'
        '<rect x="25" y="15.2" width="11.4" height="9.3" rx="1.35"/>'
        '<rect x="28.65" y="17.65" width="4.1" height="4.4" rx=".8"/>'
        '<path d="M30.7 15.2v2.45m0 4.4v2.45M25 18.3h3.65m4.1 0h3.65M25 21.4h3.65m4.1 0h3.65"/>'
        '</g>',
        # Contactless symbol.
        '<path d="M55.5 19a1.55 1.55 0 0 1 0 1.7m1.2-2.4a2.9 2.9 0 0 1 0 3.1'
        'm1.25-3.8a4.3 4.3 0 0 1 0 4.5m1.25-5.2a5.8 5.8 0 0 1 0 5.9" '
        'fill="none" stroke="#000" stroke-width=".38" stroke-linecap="round"/>',
        outline(bold, '0123 4567 0123 4567', WIDTH / 2, 34.3, 3.3),
        outline(regular, 'VALID THRU', 53.7, 39.3, 1.05),
        outline(bold, '09/39', 53.7, 42.8, 1.8),
        outline(bold, 'I LOVE', 36.3, 47.1, 2.2),
        outline(bold, 'OPTICS', 50.4, 47.1, 2.2),
        '<g fill="none" stroke="#000" stroke-width=".42">'
        '<circle cx="71.1" cy="45.5" r="3.25"/><circle cx="75.2" cy="45.5" r="3.25"/>'
        '</g>',
    ]
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="856" height="539.8" viewBox="0 0 {WIDTH} {HEIGHT}" fill="#000">\n'
    data = (svg + '\n'.join(artwork) + '\n</svg>\n').encode()
    (PUBLIC / 'reading-card.svg').write_bytes(data)
    metadata = {
        'objectWidthMm': WIDTH, 'objectHeightMm': HEIGHT,
        'assetSha256': hashlib.sha256(data).hexdigest(),
        'source': 'Original fictional Bank of Cataract credit card',
        'font': 'Atkinson Hyperlegible (SIL Open Font License 1.1)',
        'letterHeightsMm': [3.3, 3.1, 2.2, 1.8, 1.6, 1.05],
        'lineWidthsMm': [.24, .33, .38, .42],
    }
    (PUBLIC / 'reading-card.json').write_bytes((json.dumps(metadata, indent=2) + '\n').encode())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('font_dir', type=Path)
    main(parser.parse_args().font_dir)
