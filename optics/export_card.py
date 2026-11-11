"""Create the ID-1 reading card as font-independent SVG outlines."""
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
        '<path d="M5 14H80.6 M5 47H80.6" stroke="#000" stroke-width=".32"/>',
        outline(bold, 'CITY WALK', WIDTH / 2, 8.5, 4.2),
        outline(regular, 'RIVERSIDE ROUTE', WIDTH / 2, 12, 1.15),
    ]
    for center, number, stop, time, length in [
        (33.3, '08', 'Park Gate', '09:45', '280 m'),
        (52.3, '12', 'Mill Lane', '11:20', '360 m'),
    ]:
        artwork.extend([
            outline(regular, 'STOP', center, 18.5, 1.0),
            outline(bold, number, center, 25.5, 4.2),
            outline(bold, stop, center, 31.7, 2.2),
            outline(regular, time, center, 37.5, 1.6),
            outline(regular, length, center, 42.7, 1.15),
        ])
        for index, thickness in enumerate([.22, .38, .55, .85]):
            x = center - 3.9 + index * 2.4
            artwork.append(f'<path d="M{x:.2f} 44.5h1.8" stroke="#000" stroke-width="{thickness}"/>')
    artwork.append(outline(regular, 'WALKING GUIDE', WIDTH / 2, 51, 1.05))
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="856" height="539.8" viewBox="0 0 {WIDTH} {HEIGHT}" fill="#000">\n'
    data = (svg + '\n'.join(artwork) + '\n</svg>\n').encode()
    (PUBLIC / 'reading-card.svg').write_bytes(data)
    metadata = {
        'objectWidthMm': WIDTH, 'objectHeightMm': HEIGHT,
        'assetSha256': hashlib.sha256(data).hexdigest(),
        'source': 'Original fictional City Walk card',
        'font': 'Atkinson Hyperlegible (SIL Open Font License 1.1)',
        'letterHeightsMm': [4.2, 2.2, 1.6, 1.15, 1.05, 1.0],
        'lineWidthsMm': [.22, .38, .55, .85],
    }
    (PUBLIC / 'reading-card.json').write_bytes((json.dumps(metadata, indent=2) + '\n').encode())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('font_dir', type=Path)
    main(parser.parse_args().font_dir)
