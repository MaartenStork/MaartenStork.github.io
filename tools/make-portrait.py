#!/usr/bin/env python3
"""Prepare a photo for the site's ASCII portrait (writes portrait.js).

1. cut the person out:   swift tools/cutout.swift PHOTO mask.png face.json HINT_X HINT_Y
2. then:                 python3 tools/make-portrait.py PHOTO --mask mask.png --face face.json

The page converts the prepared image into characters with the same shape-matching
renderer it uses for the planets and the ship. This script crops around the face,
removes the background (using the mask), lifts the shadow behind glasses so the
eyes don't turn into holes, and balances the tones.
"""
import argparse, base64, io, json
from PIL import Image, ImageFilter, ImageOps, ImageEnhance, ImageDraw, ImageChops

ap = argparse.ArgumentParser()
ap.add_argument("photo")
ap.add_argument("--mask", required=True, help="person mask from tools/cutout.swift")
ap.add_argument("--face", required=True, help="face/landmark json from tools/cutout.swift")
ap.add_argument("--cols", type=int, default=62, help="portrait width in characters")
ap.add_argument("--out", default="portrait.js")
a = ap.parse_args()

im = ImageOps.exif_transpose(Image.open(a.photo).convert("RGB"))
mask = Image.open(a.mask).convert("L").resize(im.size)
info = json.load(open(a.face))
fx, fy, fw, fh = info["face"]

# --- lift the eyes: brighten the lens area towards the skin tone, keep a pupil ---
skin = sorted(im.convert("L").crop((int(fx + fw * 0.2), int(fy + fh * 0.55), int(fx + fw * 0.8), int(fy + fh * 0.75))).getdata())
skinL = skin[len(skin) // 2] / 255
px = im.load()
for eye, pupil in (("leftEye", "leftPupil"), ("rightEye", "rightPupil")):
    pts = info.get(eye) or []
    if not pts: continue
    ex = sum(p[0] for p in pts) / len(pts); ey = sum(p[1] for p in pts) / len(pts)
    half = max(6, (max(p[0] for p in pts) - min(p[0] for p in pts)) / 2)
    rx, ry = half * 1.9, half * 1.25                      # roughly the glasses lens
    pp = (info.get(pupil) or [[ex, ey]])[0]
    for y in range(int(ey - ry), int(ey + ry) + 1):
        for x in range(int(ex - rx), int(ex + rx) + 1):
            d = ((x - ex) / rx) ** 2 + ((y - ey) / ry) ** 2
            if d >= 1: continue
            w = (1 - d) ** 0.7                             # soft falloff
            r, g, b = px[x, y]
            l = (0.299 * r + 0.587 * g + 0.114 * b) / 255
            target = skinL * 0.82
            k = 1 + w * max(0, target - l) / max(l, 0.05)
            dp = ((x - pp[0]) ** 2 + (y - pp[1]) ** 2) ** 0.5 / half
            if dp < 0.42: k *= 0.35 + 0.65 * (dp / 0.42)    # keep the pupil dark
            px[x, y] = tuple(max(0, min(255, int(c * k))) for c in (r, g, b))

# --- crop around the face: hair above, collar below ---
box = (int(fx - fw * 0.55), int(fy - fh * 0.8), int(fx + fw * 1.55), int(fy + fh * 1.9))
im, mask = im.crop(box), mask.crop(box)

W = 320
H = round(W * im.height / im.width)
im = im.resize((W, H), Image.LANCZOS)
mask = mask.resize((W, H), Image.LANCZOS)

# --- recover curly hair the segmentation is unsure about -------------------------
# Vision's mask is weak over loose curls. In the hair zone, keep a faint-mask pixel when
# its colour is closer to the hair colour than to the background right around it.
import numpy as np
img = np.asarray(im, dtype=np.float32) / 255
m = np.asarray(mask, dtype=np.float32) / 255
def blur(a, r):
    return np.asarray(Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r)), dtype=np.float32) / 255
wbg = (m < 0.06).astype(np.float32)
wsum = blur(wbg, 9) + 1e-3
bg = np.stack([blur(img[..., c] * wbg, 9) / wsum for c in range(3)], -1)       # local background colour
sx0, sy0 = W / (box[2] - box[0]), H / (box[3] - box[1])
face_top, face_mid = (fy - box[1]) * sy0, (fy + fh * 0.55 - box[1]) * sy0
yy = np.arange(H)[:, None].repeat(W, 1)
lum = img @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
hair_px = img[(m > 0.9) & (yy < face_top + fh * sy0 * 0.1) & (lum > 0.35)]
hair = np.median(hair_px, 0) if len(hair_px) > 20 else np.array([0.75, 0.62, 0.42], dtype=np.float32)
dh = np.linalg.norm(img - hair, axis=-1)
db = np.linalg.norm(img - bg, axis=-1)
hairness = db / (db + dh + 1e-3)
# hair is textured and fairly bright; walls are smooth, railings are dark
detail = blur(np.abs(lum - blur(lum, 1.5)) * 6, 2)
recovered = (np.clip((hairness - 0.5) / 0.2, 0, 1) * (m > 0.05) * (yy < face_mid)
             * np.clip((detail - 0.12) / 0.12, 0, 1) * np.clip((lum - 0.28) / 0.12, 0, 1))
# only around the head (keeps background railings etc. out)
xx = np.arange(W)[None, :].repeat(H, 0)
hcx, hcy = (fx + fw * 0.5 - box[0]) * sx0, (fy + fh * 0.3 - box[1]) * sy0
recovered *= (((xx - hcx) / (fw * sx0 * 0.88)) ** 2 + ((yy - hcy) / (fh * sy0 * 0.95)) ** 2 < 1)
base = np.clip((m - 0.45) / 0.25, 0, 1) ** 1.5                                    # confident part, faint edges dropped
alpha = np.maximum(base, recovered)
mask = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=70, threshold=3))
im = ImageEnhance.Color(im).enhance(1.4)

# --- tones: balance on the FACE (not hair/shirt), then boost local detail ---
L = im.convert("L")
sx, sy = W / (box[2] - box[0]), H / (box[3] - box[1])
facebox = Image.new("L", (W, H))
fx0, fy0 = (fx - box[0]) * sx, (fy - box[1]) * sy
fd = ImageDraw.Draw(facebox)
fd.ellipse((fx0 + fw * sx * 0.05, fy0 + fh * sy * 0.05, fx0 + fw * sx * 0.95, fy0 + fh * sy * 1.0), fill=255)
base = ImageOps.equalize(L, mask=facebox)
blur = base.filter(ImageFilter.GaussianBlur(6))
Leq = Image.new("L", (W, H))
bp, bl, lp = base.load(), blur.load(), Leq.load()
for y in range(H):
    for x in range(W):
        v = bp[x, y] + 0.9 * (bp[x, y] - bl[x, y])          # local contrast: features pop off the skin
        t = max(0.0, min(1.0, v / 255))
        lp[x, y] = int(255 * (t * t * (3 - 2 * t) * 0.5 + t * 0.5))

out = Image.new("RGB", (W, H))
src, lo, le, mk, op = im.load(), L.load(), Leq.load(), mask.load(), out.load()
for y in range(H):
    for x in range(W):
        r, g, b = src[x, y]
        k = (0.35 * lo[x, y] + 0.65 * le[x, y] + 1) / (lo[x, y] + 1) * (mk[x, y] / 255)
        op[x, y] = tuple(max(0, min(255, int(c * k))) for c in (r, g, b))

buf = io.BytesIO()
out.save(buf, "JPEG", quality=90)
b64 = base64.b64encode(buf.getvalue()).decode()
with open(a.out, "w") as f:
    f.write("/* generated by tools/make-portrait.py */\n")
    f.write(f"window.PORTRAIT = {{ cols: {a.cols}, src: 'data:image/jpeg;base64,{b64}' }};\n")
prev = a.out.rsplit(".", 1)[0] + "-preview.png"
out.save(prev)
print(f"wrote {a.out} ({len(b64) // 1024} KB), preview {prev}")
