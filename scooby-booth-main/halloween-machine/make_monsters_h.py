"""
Pack the JPGs in sd_card/monsters into a C header so the images are compiled
into the ESP32 program (no SD card needed).

    python make_monsters_h.py sd_card/monsters esp32_monster_tv/monsters.h

Run it again whenever the images change, then re-upload the ESP32 sketch.
"""
import sys
from pathlib import Path

if len(sys.argv) < 3:
    print(__doc__)
    sys.exit(1)

src, out = Path(sys.argv[1]), Path(sys.argv[2])
files = sorted(src.glob("*.jpg"))
lines = ["// Auto-generated, do not edit. Regenerate with: python make_monsters_h.py", "#pragma once", "#include <Arduino.h>", ""]
total = 0
for i, f in enumerate(files):
    data = f.read_bytes()
    total += len(data)
    lines.append(f"// {f.name}")
    lines.append(f"const uint8_t MONSTER_{i}[] PROGMEM = {{")
    for j in range(0, len(data), 24):
        lines.append("  " + ",".join(f"0x{b:02x}" for b in data[j:j + 24]) + ",")
    lines.append("};")
    lines.append("")
lines.append("const uint8_t* const MONSTERS[] = {" + ", ".join(f"MONSTER_{i}" for i in range(len(files))) + "};")
lines.append("const uint32_t MONSTER_SIZES[] = {" + ", ".join(str(len(f.read_bytes())) for f in files) + "};")
lines.append(f"const int MONSTER_COUNT = {len(files)};")
out.write_text("\n".join(lines) + "\n")
print(f"{len(files)} images, {total/1024:.0f} KB total -> {out}")
