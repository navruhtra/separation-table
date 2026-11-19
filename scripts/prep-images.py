# Decode the regression images into raw RGBA for bench-test.mjs (long side capped at 900 px, like the UI preview).
# Source: test-images/ (scripts/make-test-images.py draws 04-18; 01-03 are ADN synthetic drawings, see NOTICE; 19-30 are
# museum photographs of public-domain works, see test-images/SOURCES.md).
import json, os, shutil
from PIL import Image
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the repository root; this file is in scripts/
srcs = [os.path.join(here, "test-images")]
out = os.path.join(here, ".cache/img"); os.makedirs(out, exist_ok=True); meta = {}
for src in srcs:
    for f in sorted(os.listdir(src)):
        if not f.endswith((".png", ".jpg")): continue
        im = Image.open(os.path.join(src, f)).convert("RGBA"); s = min(1, 900 / max(im.size))
        if s < 1: im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
        name = f[:-4]; open(os.path.join(out, name + ".rgba"), "wb").write(im.tobytes()); meta[name] = im.size
json.dump(meta, open(os.path.join(out, "meta.json"), "w"))
shutil.copy(os.path.join(here, "test-images/cases.json"), os.path.join(out, "cases.json"))
print(len(meta), "images")
