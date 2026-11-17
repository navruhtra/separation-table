"""Open every job file with programs we did not write, and compare what they read with what went in.

    node tests/readback.mjs <dir>                  write the files and expect.json
    python3 -I tests/outside-readers.py <dir> [--require]

Readers: Ghostscript renders the EPS films, the film PDF and the DCS file
(pixel for pixel against the film) and reads the text of the job and mix
sheets; tiffinfo and Pillow read the TIFF films; psd-tools reads the
Photoshop files. A missing reader is a skip, or a FAIL with --require (CI).
"""
import base64, json, os, shutil, subprocess, sys, tempfile

dir_, require = sys.argv[1], "--require" in sys.argv
X = json.load(open(os.path.join(dir_, "expect.json")))
W, H, DPI = X["W"], X["H"], X["dpi"]
fails = 0


def ok(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def missing(what):
    ok(not require, f"outside reader {what} is not installed" + ("" if require else " (skipped)"))


def bits(film):
    return base64.b64decode(film["bits"])


def gs(args, out=None):
    r = subprocess.run(["gs", "-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", *args], capture_output=True)
    return r.returncode, r.stdout, r.stderr.decode("latin1")


def pbm_bits(data):
    """P4 (raw PBM) to one byte per pixel, 1 = black."""
    parts, i = [], 0
    while len(parts) < 3:
        while data[i:i + 1].isspace():
            i += 1
        if data[i:i + 1] == b"#":
            i = data.index(b"\n", i)
            continue
        j = i
        while not data[j:j + 1].isspace():
            j += 1
        parts.append(data[i:j])
        i = j
    w, h, raster, rb = int(parts[1]), int(parts[2]), data[i + 1:], (int(parts[1]) + 7) // 8
    return w, h, bytes((raster[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1 for y in range(h) for x in range(w))


# Ghostscript: EPS films, film PDF, DCS, and the text of the sheets
if shutil.which("gs"):
    with tempfile.TemporaryDirectory() as tmp:
        for k, film in enumerate(X["films"]):
            f = os.path.join(dir_, "eps", film["slug"] + ".eps")
            code, out, err = gs(["-sDEVICE=pbmraw", f"-r{DPI}", "-dEPSCrop", "-sOutputFile=-", f])
            w, h, px = pbm_bits(out) if code == 0 else (0, 0, b"")
            ok(code == 0 and (w, h) == (W, H) and px == bits(film), f"Ghostscript renders eps/{film['slug']}.eps at {DPI} DPI to the film's pixels")
        pages = os.path.join(tmp, "page-%d.pbm")
        code, _, err = gs(["-sDEVICE=pbmraw", f"-r{DPI}", f"-sOutputFile={pages}", os.path.join(dir_, "films.pdf")])
        for k, film in enumerate(X["films"]):
            p = pages % (k + 1)
            w, h, px = pbm_bits(open(p, "rb").read()) if code == 0 and os.path.exists(p) else (0, 0, b"")
            ok((w, h) == (W, H) and px == bits(film), f"Ghostscript renders films.pdf page {k + 1} at {DPI} DPI to the film's pixels")
        if X["dcs"]:
            code, _, err = gs(["-sDEVICE=nullpage", "-dEPSCrop", os.path.join(dir_, "separations-dcs.eps")])
            ok(code == 0, "Ghostscript opens the DCS 2.0 file without an error" + (f": {err.strip()[:200]}" if code else ""))
        for name, head in (("job-sheet.pdf", "JOB SHEET"), ("mix-sheet.pdf", "INK MIX SHEET")):
            code, out, err = gs(["-sDEVICE=txtwrite", "-sOutputFile=-", os.path.join(dir_, name)])
            text = out.decode("utf-8", "replace")
            want = [head, *X["screens"]] + ([f"Separation Table {X['version']}"] if name == "job-sheet.pdf" else [])
            ok(code == 0 and all(t in text for t in want), f"Ghostscript reads {name}: {', '.join(want)}")
else:
    missing("Ghostscript (gs)")

# tiffinfo (libtiff) and Pillow: the TIFF films
if shutil.which("tiffinfo"):
    for film in X["films"]:
        f = os.path.join(dir_, "tiff", film["slug"] + ".tif")
        r = subprocess.run(["tiffinfo", f], capture_output=True, text=True)
        t = r.stdout + r.stderr
        want = [f"Image Width: {W} Image Length: {H}", f"Resolution: {DPI}, {DPI} pixels/inch", "Bits/Sample: 1", "Compression Scheme: PackBits", "Photometric Interpretation: min-is-white"]
        ok(r.returncode == 0 and all(s in t for s in want) and "Warning" not in t and "Error" not in t, f"tiffinfo reads tiff/{film['slug']}.tif: 1-bit, PackBits, {DPI} DPI, no warnings")
else:
    missing("tiffinfo (libtiff)")
try:
    from PIL import Image
    for film in X["films"]:
        im = Image.open(os.path.join(dir_, "tiff", film["slug"] + ".tif"))
        px = bytes(0 if v else 1 for v in im.convert("L").tobytes())
        dpi = tuple(round(float(v)) for v in im.info.get("dpi", (0, 0)))
        ok(im.mode == "1" and im.size == (W, H) and dpi == (DPI, DPI) and px == bits(film), f"Pillow opens tiff/{film['slug']}.tif as 1-bit {W}x{H} at {DPI} DPI with the film's pixels")
except ImportError:
    missing("Pillow")

# psd-tools: the Photoshop files
try:
    from psd_tools import PSDImage
    for name, mode, comps in (("separations.psd", 7, 0), ("separations-preview-rgb.psd", 3, 3)):
        p = PSDImage.open(os.path.join(dir_, name))
        rec = p._record  # the parsed file: psd-tools has no public call for the raw channel planes
        planes = [bytes(c) for c in rec.image_data.get_data(rec.header)]
        names = p.image_resources.get_data(1045)
        res = p.image_resources.get_data(1005)  # 16.16 fixed point
        names_ok = list(names) == [c["name"] for c in X["channels"]]
        tones_ok = all(planes[comps + k] == base64.b64decode(c["tone"]) for k, c in enumerate(X["channels"]))
        ok(int(p.color_mode) == mode and p.depth == 8 and (p.width, p.height) == (W, H) and p.channels == comps + len(X["channels"]) and round(res.horizontal / 65536) == DPI and names_ok and tones_ok,
           f"psd-tools opens {name} as {'Multichannel' if mode == 7 else 'RGB'} {W}x{H} at {DPI} DPI with the spot channels named in print order and their pixels")
except ImportError:
    missing("psd-tools")

print(f"{fails} FAILED" if fails else "all passed")
sys.exit(1 if fails else 0)
