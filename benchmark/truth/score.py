# Benchmark, vector truth: score a simulated print (print.mjs) against the vector original, as the eye sees it at two
# distances. usage: python3 score.py <print.rgb>  -> JSON on stdout. Needs numpy and scipy.
#   close: Gaussian blur sigma 1.6 px at 400 dpi (about 0.1 mm); arm: 6 px (about 0.38 mm, arm's length).
#   edges / solid / glow: mean CIELAB distance in each region (masks from prep.py); edgeOff: share of edge pixels off by
#   more than 10; offset: light-shape edge offset in px (0.1 mm = 1.6 px); specks: stray light specks outside the shapes.
import json, os, sys
import numpy as np
from scipy.ndimage import gaussian_filter, label

T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../.cache/benchmark/truth"); Wt, Ht = 4400, 2933
tr = np.fromfile(T + "/truth.rgba", np.uint8).reshape(Ht, Wt, 4).astype(float); sh = np.array([17., 17, 17])
truth = tr[..., :3] * (tr[..., 3:] / 255) + sh * (1 - tr[..., 3:] / 255)
edge, glow = np.load(T + "/masks.npy"); inner = ~edge & ~glow
def lab(rgb):
    c = rgb / 255; c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]); xyz = c @ M.T / np.array([0.9505, 1, 1.089])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116); return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)
blur = lambda a, s: np.stack([gaussian_filter(a[..., c], s) for c in range(3)], -1)
pr = np.fromfile(sys.argv[1], np.uint8).reshape(Ht, Wt, 3).astype(float); out = {}
for s, nm in [(1.6, "close"), (6, "arm")]:
    de = np.linalg.norm(lab(blur(pr, s)) - lab(blur(truth, s)), axis=-1)
    out[nm] = {"edges": round(float(de[edge].mean()), 3), "solid": round(float(de[inner].mean()), 3), "glow": round(float(de[glow].mean()), 3), "edgeOff": round(float(100 * (de[edge] > 10).mean()), 2)}
tm = lab(blur(truth, 1.6))[..., 0] > 55; per = (tm ^ np.roll(tm, 1, 0)).sum() + (tm ^ np.roll(tm, 1, 1)).sum()
pm = lab(blur(pr, 1.6))[..., 0] > 55; lb, n = label(pm & ~tm); sizes = np.bincount(lb.ravel())[1:]
out["offset"] = round(float((pm ^ tm).sum() / per), 3); out["specks"] = int((sizes < 40).sum())
print(json.dumps(out))
