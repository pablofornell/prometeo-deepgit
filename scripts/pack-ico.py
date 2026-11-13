"""Packs src-tauri/icons/icon.ico with two sources, so each size comes from the right variant.

Needs Pillow (`pip install pillow`). Called by scripts/gen-icons.sh.

Usage: python3 scripts/pack-ico.py SMALL_ICO LARGE_ICO OUT_ICO

- SMALL_ICO: an ICO made from the small logo. Its 16, 24, 32 and 48 px layers are used.
- LARGE_ICO: an ICO made from the large logo. Its 64 and 256 px layers are used.

The layers are PNG-compressed. The ICO format accepts PNG layers from Windows Vista on.
"""

import io
import struct
import sys

from PIL import Image

SMALL_SIZES = [16, 24, 32, 48]
LARGE_SIZES = [64, 256]


def layer(path, size):
    """PNG bytes of one size, taken from an ICO file."""
    ico = Image.open(path)
    img = ico.ico.getimage((size, size)).convert("RGBA")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return size, buf.getvalue()


def main(argv):
    if len(argv) != 4:
        sys.exit("usage: python3 scripts/pack-ico.py SMALL_ICO LARGE_ICO OUT_ICO")
    small_ico, large_ico, out = argv[1], argv[2], argv[3]

    layers = [layer(small_ico, s) for s in SMALL_SIZES] + [layer(large_ico, s) for s in LARGE_SIZES]
    header = struct.pack("<HHH", 0, 1, len(layers))
    offset = 6 + 16 * len(layers)
    entries, blobs = b"", b""
    for size, png in layers:
        dim = 0 if size >= 256 else size  # 0 means 256 in the ICO directory
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
        blobs += png
    with open(out, "wb") as fh:
        fh.write(header + entries + blobs)
    print(f"wrote {out} with layers {[s for s, _ in layers]}")


if __name__ == "__main__":
    main(sys.argv)
