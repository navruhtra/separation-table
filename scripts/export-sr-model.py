# Build src/models/sr_x2.onnx (2x upscale) from the Apache-2.0 Swin2SR weights, so the
# kit ships an export ADN made itself rather than a third-party ONNX file.
#
# Weights: Swin2SR lightweight x2 (patch 64) by Conde et al., mv-lab/swin2sr,
#   Apache-2.0, as converted to Hugging Face format in caidas/swin2SR-lightweight-x2-64
#   (model card: license apache-2.0). Pinned to one revision and one SHA-256 below.
#
# Needs Python 3.10+ with: torch 2.5.1, transformers 4.46.3, onnx 1.17.0,
# onnxruntime 1.20.1, numpy (CPU builds are enough). Run isolated:
#   python3 -I scripts/export-sr-model.py                 -> src/models/sr_x2.onnx
#   python3 -I scripts/export-sr-model.py --compare F.onnx   also compares with another export
# Weights are downloaded into .cache/swin2sr-<revision>/ (an empty folder of their own).
# The export is checked against PyTorch at every tile size ai.js sends (multiples of 8).
import argparse, hashlib, os, sys, urllib.request

REPO = "caidas/swin2SR-lightweight-x2-64"
REVISION = "07e8e61492ce6daf4f34c651622960faf110c17f"
FILES = {
    "config.json": None,
    "model.safetensors": "1b7a135af7de4287289c59939bf735de5afa9927a943bd946920acdcf4dd6365",
}
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the repository root; this file is in scripts/
TILE_SIZES = [(8, 8), (16, 24), (64, 64), (104, 104), (112, 112), (112, 56)]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()


def download(dest):
    os.makedirs(dest, exist_ok=True)
    for name, want in FILES.items():
        path = os.path.join(dest, name)
        if not os.path.exists(path):
            url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}"
            print("download", url)
            urllib.request.urlretrieve(url, path + ".part"); os.replace(path + ".part", path)
        if want and sha256(path) != want:
            sys.exit(f"{name}: SHA-256 {sha256(path)} does not match the pinned {want}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "src", "models", "sr_x2.onnx"))
    ap.add_argument("--compare", help="another ONNX export of the same weights to compare against")
    a = ap.parse_args()
    import numpy as np, onnxruntime as rt, torch
    from transformers import Swin2SRForImageSuperResolution

    src = os.path.join(HERE, ".cache", f"swin2sr-{REVISION[:12]}")
    download(src)
    model = Swin2SRForImageSuperResolution.from_pretrained(src).eval()

    class Upscaler(torch.nn.Module):  # one input, one output, named as ai.js expects
        def __init__(self, m): super().__init__(); self.m = m
        def forward(self, pixel_values): return self.m(pixel_values=pixel_values).reconstruction

    # PyTorch references first: tracing for export leaves the model in a state whose outputs differ.
    rng = np.random.default_rng(369)
    cases = []
    for h, w in TILE_SIZES:
        x = rng.random((1, 3, h, w), dtype=np.float32)
        with torch.no_grad(): cases.append((h, w, x, model(pixel_values=torch.from_numpy(x)).reconstruction.numpy()))
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    torch.onnx.export(Upscaler(model), torch.rand(1, 3, 64, 64), a.out, opset_version=17, dynamo=False,
                      input_names=["pixel_values"], output_names=["reconstruction"],
                      dynamic_axes={"pixel_values": {0: "batch", 2: "height", 3: "width"},
                                    "reconstruction": {0: "batch", 2: "height", 3: "width"}})
    ours = rt.InferenceSession(a.out, providers=["CPUExecutionProvider"])
    other = rt.InferenceSession(a.compare, providers=["CPUExecutionProvider"]) if a.compare else None
    worst = 0.0
    for h, w, x, ref in cases:
        y = ours.run(["reconstruction"], {"pixel_values": x})[0]
        if y.shape != (1, 3, 2 * h, 2 * w): sys.exit(f"{h}x{w}: output shape {y.shape}")
        d = float(np.abs(y - ref).max()); worst = max(worst, d)
        line = f"tile {h}x{w}: max |onnx - torch| = {d:.2e}"
        if other:
            z = other.run(None, {"pixel_values": x})[0]
            line += f", max |ours - compare| = {float(np.abs(y - z).max()):.2e}"
        print(line)
    if worst > 1e-3: sys.exit(f"export differs from PyTorch by {worst:.2e} (limit 1e-3)")
    print(f"wrote {a.out} ({os.path.getsize(a.out)} bytes, SHA-256 {sha256(a.out)})")


if __name__ == "__main__":
    main()
