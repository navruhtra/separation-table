# Generate ADN's own regression test images (no third-party content, so no license questions).
# Each image targets a known separation failure mode; cases.json says how to separate it.
#   python3 scripts/make-test-images.py   -> test-images/*.png + test-images/cases.json
import json, math, os, random
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test-images")
os.makedirs(OUT, exist_ok=True)
random.seed(369)
S = 600
cases = []

def font(px):
    for f in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"]:
        if os.path.exists(f): return ImageFont.truetype(f, px)
    return ImageFont.load_default()

def lerp(a, b, t): return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))

def save(name, im, mode, garment, k, note, fades=None):
    im.save(os.path.join(OUT, name + ".png"), optimize=True)
    cases.append({"img": name, "mode": mode, "garment": garment, "k": k, "note": note, **({"fades": fades} if fades else {})})

# 04 hue wheel on black: every hue at full and half chroma (palette coverage, highlight white restraint)
im = Image.new("RGBA", (S, S), (0, 0, 0, 0)); px = im.load(); c = S / 2
for y in range(S):
    for x in range(S):
        dx, dy = x - c, y - c; r = math.hypot(dx, dy) / (S * 0.46)
        if r > 1: continue
        h = (math.degrees(math.atan2(dy, dx)) + 360) % 360 / 60; i = int(h) % 6; f = h - int(h)
        q = [(1, f, 0), (1 - f, 1, 0), (0, 1, f), (0, 1 - f, 1), (f, 0, 1), (1, 0, 1 - f)][i]
        v = 0.25 + 0.75 * r
        px[x, y] = tuple(round(255 * (1 - r * 0.0) * (v * qq + (1 - v) * 0.5)) for qq in q) + (255,)
save("04-hue-wheel-black", im, "sim", [17, 17, 17], 7, "every hue; checks palette coverage and that white stays out of saturated colors")

# 05 neutral ramps on black: grays and a warm-gray ramp (gray balance, shirt-as-black fade)
im = Image.new("RGB", (S, S), (17, 17, 17)); d = ImageDraw.Draw(im)
for x in range(40, S - 40):
    t = (x - 40) / (S - 80)
    d.line([(x, 80), (x, 260)], fill=lerp((17, 17, 17), (245, 245, 240), t))
    d.line([(x, 340), (x, 520)], fill=lerp((30, 24, 20), (236, 222, 200), t))
save("05-neutral-ramps-black", im, "sim", [17, 17, 17], 5, "gray and warm-gray ramps fading into the shirt")

# 06 fine detail spot on white: thin lines, small type, tiny dots (edge cleanup must not eat detail)
im = Image.new("RGBA", (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
for i in range(12): d.line([(40, 40 + i * 14), (560, 40 + i * 14)], fill=(0, 51, 160, 255), width=1 + i % 3)
d.text((40, 230), "SMALL TYPE 8 PT", fill=(200, 16, 46, 255), font=font(18))
d.text((40, 270), "Fine print holds at 2px strokes", fill=(0, 0, 0, 255), font=font(14))
for i in range(30):
    for j in range(8): d.ellipse([40 + i * 17, 330 + j * 17, 44 + i * 17 + (i % 3), 334 + j * 17 + (i % 3)], fill=(0, 132, 61, 255))
d.rectangle([40, 500, 560, 560], fill=(200, 16, 46, 255)); d.text((60, 512), "ADN SPOT", fill=(255, 255, 255, 255), font=font(36))
save("06-fine-detail-spot-white", im, "spot", [255, 255, 255], 4, "thin lines, small type and dots on a white shirt")

# 07 pastel illustration on navy (light colors need base; navy shirt not black)
im = Image.new("RGB", (S, S), (28, 42, 74)); d = ImageDraw.Draw(im)
for i, col in enumerate([(248, 200, 220), (200, 230, 210), (255, 240, 190), (190, 215, 245), (230, 210, 250)]):
    d.ellipse([60 + i * 90, 120 + (i % 2) * 120, 220 + i * 90, 280 + (i % 2) * 120], fill=col)
d.rectangle([60, 460, 540, 520], fill=(250, 245, 235))
im = im.filter(ImageFilter.GaussianBlur(1.5))
save("07-pastels-navy", im, "sim", [28, 42, 74], 6, "pastels on a navy shirt")

# 08 earth-tone landscape on sand (browns, olives, tans: the known weak spot) — light garment, no base
im = Image.new("RGB", (S, S), (201, 180, 143)); d = ImageDraw.Draw(im)
for y in range(S):
    t = y / S; d.line([(0, y), (S, y)], fill=lerp((214, 170, 110), (110, 70, 40), t))
d.polygon([(0, 380), (180, 250), (320, 330), (460, 220), (600, 330), (600, 600), (0, 600)], fill=(96, 98, 52))
d.polygon([(0, 470), (260, 400), (600, 460), (600, 600), (0, 600)], fill=(70, 46, 28))
d.ellipse([420, 60, 520, 160], fill=(240, 210, 150))
im = im.filter(ImageFilter.GaussianBlur(2))
save("08-earth-tones-sand", im, "sim", [201, 180, 143], 5, "browns, olives and tans on a sand shirt")

# 09 neon on black (very high chroma: gamut limits, base under saturated color)
im = Image.new("RGB", (S, S), (17, 17, 17)); d = ImageDraw.Draw(im)
for i, col in enumerate([(255, 20, 147), (57, 255, 20), (0, 240, 255), (255, 230, 0)]):
    d.rounded_rectangle([50 + i * 135, 80, 160 + i * 135, 520], radius=0, fill=col)
im = im.filter(ImageFilter.GaussianBlur(6))
save("09-neon-black", im, "sim", [17, 17, 17], 5, "high-chroma neon glows on black")

# 10 three-color vintage on heather (limited palette, mid-gray garment)
im = Image.new("RGBA", (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
d.ellipse([100, 60, 500, 460], fill=(176, 58, 46, 255)); d.ellipse([170, 130, 430, 390], fill=(240, 228, 200, 255))
d.text((150, 470), "EST 1972", fill=(32, 44, 64, 255), font=font(64))
save("10-vintage-3color-heather", im, "spot", [118, 118, 118], 3, "three spot colors on a charcoal heather shirt")

# 11 photographic skin close-up with grain on black (skin, noise robustness)
im = Image.new("RGB", (S, S), (17, 17, 17)); px = im.load()
for y in range(S):
    for x in range(S):
        r = math.hypot((x - 300) / 230, (y - 320) / 280)
        if r < 1:
            t = 1 - r; base = lerp((92, 52, 32), (238, 196, 160), t ** 0.7)
            n = random.gauss(0, 7); px[x, y] = tuple(max(0, min(255, round(v + n))) for v in base)
d = ImageDraw.Draw(im); d.ellipse([230, 260, 280, 290], fill=(40, 26, 20)); d.ellipse([330, 260, 380, 290], fill=(40, 26, 20)); d.ellipse([255, 420, 345, 450], fill=(170, 80, 70))
save("11-skin-grain-black", im, "sim", [17, 17, 17], 6, "skin gradient with photographic grain")

# 12 shirt-color knockout on red (art uses the garment as a color)
im = Image.new("RGB", (S, S), (180, 20, 35)); d = ImageDraw.Draw(im)
d.rectangle([60, 60, 540, 540], fill=(250, 250, 245)); d.rectangle([140, 140, 460, 460], fill=(180, 20, 35)); d.ellipse([230, 230, 370, 370], fill=(20, 20, 20))
save("12-knockout-red", im, "spot", [180, 20, 35], 2, "art that leaves the red shirt showing as a color")

# 13 smooth sky gradient on black (banding)
im = Image.new("RGB", (S, S), (17, 17, 17)); d = ImageDraw.Draw(im)
for y in range(60, 540):
    t = (y - 60) / 480; d.line([(60, y), (540, y)], fill=lerp((14, 30, 80), (255, 170, 90), t))
save("13-sky-gradient-black", im, "sim", [17, 17, 17], 5, "long smooth gradient; checks banding")

# 14 index-style limited art on black (index separation)
im = Image.new("RGB", (S, S), (17, 17, 17)); d = ImageDraw.Draw(im)
for i in range(6):
    d.pieslice([60, 60, 540, 540], i * 60, i * 60 + 60, fill=[(230, 57, 70), (241, 250, 238), (168, 218, 220), (69, 123, 157), (29, 53, 87), (244, 162, 97)][i])
im = im.filter(ImageFilter.GaussianBlur(10))
save("14-index-blend-black", im, "index", [17, 17, 17], 6, "blended wedges for index separation")

# 15 white garment photo-style sim (no underbase case)
im = Image.new("RGB", (S, S), (255, 255, 255)); px = im.load()
for y in range(S):
    for x in range(S):
        u, v = x / S, y / S
        px[x, y] = (round(255 * (0.5 + 0.5 * math.sin(6 * u))), round(255 * v), round(255 * (0.5 + 0.5 * math.cos(5 * v + 3 * u))))
save("15-photo-white", im, "sim", [255, 255, 255], 6, "full-color image on a white shirt, no underbase")

# 16-18 gradient set: 8-bit linear fades, each strip from x 40 to 560 (fades = [x0, y0, x1, y1] boxes the gradient-steps
# metric reads along their long side). Common shop inks: white, red, royal, gold, kelly, orange, black.
INK = {"white": (245, 245, 240), "red": (200, 16, 46), "royal": (0, 51, 160), "gold": (255, 184, 28), "kelly": (0, 132, 61), "orange": (255, 103, 31), "black": (20, 20, 20)}
def strips(name, garment, pairs, mode, k, note):
    im = Image.new("RGB", (S, S), garment); d = ImageDraw.Draw(im); h = (S - 40) // len(pairs); fades = []
    for i, (a, b) in enumerate(pairs):
        y0, y1 = 20 + i * h + 6, 20 + (i + 1) * h - 6
        for x in range(40, S - 40): d.line([(x, y0), (x, y1)], fill=lerp(a, b, (x - 40) / (S - 81)))
        fades.append([44, y0 + 4, S - 44, y1 - 4])
    save(name, im, mode, list(garment), k, note, fades)
B, Wt = (17, 17, 17), (255, 255, 255)
# 16 one ink fading into the black shirt (each ramp needs one ink and the base: checks the low end and the base end)
strips("16-ink-ramps-black", B, [(B, INK[c]) for c in ["white", "red", "royal", "gold", "kelly", "orange"]], "sim", 6, "one ink at a time fading into the black shirt")
# 17 ink-to-ink fades on black (where one ink ends and the next begins)
strips("17-ink-to-ink-black", B, [(INK["red"], INK["gold"]), (INK["royal"], INK["white"]), (INK["kelly"], INK["gold"]), (INK["red"], INK["royal"]), (INK["orange"], INK["white"])], "sim", 6, "one ink fading into another on black")
# 18 fades into a white shirt (no base: the ink alone must reach 0)
strips("18-fade-to-shirt-white", Wt, [(Wt, INK[c]) for c in ["red", "royal", "gold", "kelly", "black"]], "sim", 5, "inks fading into a white shirt")

# the three ADN synthetic drawings kept in test-images/ (01-03, not drawn here), with their established settings
for name, mode, g, k, note in [("01-sunset-sim-process", "sim", [17, 17, 17], 6, "gradients on black"), ("02-spot-logo-transparent", "spot", [255, 255, 255], 4, "four flat colors"), ("03-portrait-skin-tones", "sim", [17, 17, 17], 6, "skin and browns, noisy")]:
    cases.insert(0, {"img": name, "mode": mode, "garment": g, "k": k, "note": note, "src": "research"})
# fades the gradient-steps metric reads in the existing images: sunset sky beside the sun, ramps, sky
FADES = {"01-sunset-sim-process": [[440, 110, 460, 380], [300, 140, 320, 500]], "05-neutral-ramps-black": [[44, 84, 556, 256], [44, 344, 556, 516]], "13-sky-gradient-black": [[200, 62, 400, 538]]}
for c in cases:
    if c["img"] in FADES: c["fades"] = FADES[c["img"]]
cases.sort(key=lambda c: c["img"])
json.dump(cases, open(os.path.join(OUT, "cases.json"), "w"), indent=1)
print(len(cases), "cases")
