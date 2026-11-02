"""
Convert monster images for the ESP32 screen: 320x480 portrait, baseline JPG.
(The ESP32 JPG decoder doesn't support progressive JPG, and PNG decoding is slow,
so everything is converted to baseline JPG.)

    pip install pillow
    python convert_images.py <source_folder> sd_card/monsters

Then either:
  - built-in images (default): python make_monsters_h.py sd_card/monsters esp32_monster_tv/monsters.h
    and re-upload the ESP32 sketch, or
  - SD card (USE_SD true): copy the "monsters" folder to the root of a FAT32 SD card.
"""

import sys
from pathlib import Path

from PIL import Image, ImageOps

W, H = 320, 480


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    dst.mkdir(parents=True, exist_ok=True)
    exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    files = sorted(p for p in src.iterdir() if p.suffix.lower() in exts)
    for i, p in enumerate(files, 1):
        img = Image.open(p)
        img = ImageOps.exif_transpose(img).convert("RGB")
        if img.width > img.height:          # rotate landscape images to portrait
            img = img.rotate(90, expand=True)
        img = ImageOps.fit(img, (W, H), Image.LANCZOS)   # scale to fill, center-crop
        # short file names are the safest for FAT32 + ESP32
        out = dst / f"m{i:02d}.jpg"
        img.save(out, "JPEG", quality=90, optimize=False, progressive=False, subsampling=0)
        print(f"{p.name} -> {out.name}")
    print(f"Done, {len(files)} images")


if __name__ == "__main__":
    main()
