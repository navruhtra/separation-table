# Decode the benchmark's images into raw RGBA under .cache/benchmark (run.mjs calls this; safe to run again).
# Vector truth: truth.png / input.png -> .rgba, plus the
# region masks the score reads (edges: colour changes within 6 px at film size; glow: the soft glow; the rest: solid).
import json, os, sys
import numpy as np
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "../.cache/benchmark"); os.makedirs(out + "/truth", exist_ok=True)

T = f"{out}/truth"
if not os.path.exists(f"{T}/masks.npy"):
    truth = Image.open(os.path.join(here, "truth/truth.png")).convert("RGBA"); inp = Image.open(os.path.join(here, "truth/input.png")).convert("RGBA")
    open(f"{T}/truth.rgba", "wb").write(truth.tobytes()); open(f"{T}/input.rgba", "wb").write(inp.tobytes())
    # the same masks truth/make.py writes (S = film px per art px; the glow sits at art (720, 450), radius 120)
    Wt, Ht = truth.size; S = Wt / inp.size[0]
    a = np.asarray(truth).astype(np.int16); sh = np.array([17, 17, 17]); comp = a[..., :3] * (a[..., 3:] / 255) + sh * (1 - a[..., 3:] / 255)
    mx = np.zeros(comp.shape[:2])
    for dy in range(-6, 7, 3):
        for dx in range(-6, 7, 3): mx = np.maximum(mx, np.abs(np.roll(comp, (dy, dx), (0, 1)) - comp).sum(2))
    edge = mx > 40; gy, gx = np.mgrid[0:Ht, 0:Wt]; glow = (np.hypot(gx - 720 * S, gy - 450 * S) < 120 * S) & ~edge
    np.save(f"{T}/masks.npy", np.stack([edge, glow]))
print("vector truth ready", file=sys.stderr)
