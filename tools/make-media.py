#!/usr/bin/env python3
"""Make the publication visuals in media/.

    python3 tools/make-media.py --robot ROBOT.jpg --particles PARTICLES.gif

robot      -> media/gecco-robot.jpg      (web-sized photo)
particles  -> media/nanoparticles.webp   (animated, white background removed so the
                                          particles float; labels underneath cropped off)
"""
import argparse, os
import numpy as np
from PIL import Image, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "media")
os.makedirs(OUT, exist_ok=True)

ap = argparse.ArgumentParser()
ap.add_argument("--robot")
ap.add_argument("--particles")
ap.add_argument("--crop-bottom", type=float, default=0.75, help="keep this top fraction of the particles gif (drops the labels)")
ap.add_argument("--robot-mask", help="subject mask from tools/lift.swift: cut the robot out (transparent webp)")
a = ap.parse_args()

if a.robot and not a.robot_mask:
    im = ImageOps.exif_transpose(Image.open(a.robot)).convert("RGB")
    im.thumbnail((960, 960), Image.LANCZOS)
    im.save(os.path.join(OUT, "gecco-robot.jpg"), "JPEG", quality=84, optimize=True, progressive=True)
    print("gecco-robot.jpg", im.size)

if a.robot and a.robot_mask:
    # floating cut-out: subject only, floor seen through the open frames removed,
    # black parts lifted to dark grey so they still read on a dark site
    im = ImageOps.exif_transpose(Image.open(a.robot)).convert("RGB")
    m = Image.open(a.robot_mask).convert("L").resize(im.size)
    rgb = np.asarray(im, dtype=np.float32) / 255
    alpha = np.asarray(m, dtype=np.float32) / 255
    mn, mx = rgb.min(-1), rgb.max(-1)
    floor = ((mn > 0.40) & ((mx - mn) < 0.13)) | ((mn > 0.55) & ((mx - mn) < 0.24))   # grey + beige floor
    alpha = np.where(floor, 0, alpha)
    rgb = np.maximum(rgb, 0.16 + rgb * 0.2)
    out = Image.fromarray((np.dstack([rgb, alpha]) * 255).clip(0, 255).astype(np.uint8), "RGBA")
    out = out.filter(ImageFilter.SMOOTH) if False else out
    out = out.crop(out.getbbox())
    out.thumbnail((620, 620), Image.LANCZOS)
    out.save(os.path.join(OUT, "gecco-robot.webp"), "WEBP", quality=82, method=6)
    out.save(os.path.join(HERE, "robot-preview.png"))
    print("gecco-robot.webp", out.size, os.path.getsize(os.path.join(OUT, "gecco-robot.webp")) // 1024, "KB")


def cut_white(frame):
    """RGBA: pure-white background (also the gaps between particles) becomes transparent."""
    rgb = np.asarray(frame.convert("RGB"), dtype=np.float32) / 255
    mn, mx = rgb.min(-1), rgb.max(-1)
    alpha = np.clip((0.985 - mn) / 0.09, 0, 1)
    # un-blend the white the edges were anti-aliased against (no white fringe)
    a3 = np.maximum(alpha, 1e-3)[..., None]
    rgb = np.clip((rgb - (1 - a3)) / a3, 0, 1)
    # black / grey labels -> light, so they read on a dark site
    grey = (rgb.max(-1) - rgb.min(-1)) < 0.12
    dark = rgb.max(-1) < 0.55
    lift = grey & dark & (alpha > 0.5)
    rgb[lift] = 0.95 - rgb[lift] * 0.5
    out = np.dstack([rgb, alpha]) * 255
    return Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA")


if a.particles:
    src = Image.open(a.particles)
    frames, durs = [], []
    W = 680
    for i in range(getattr(src, "n_frames", 1)):
        src.seek(i)
        f = src.convert("RGB")
        f = f.crop((0, 0, f.width, round(f.height * a.crop_bottom)))      # drop the text labels underneath
        f = f.resize((W, round(W * f.height / f.width)), Image.LANCZOS)
        frames.append(cut_white(f))
        durs.append(src.info.get("duration", 80))
    path = os.path.join(OUT, "nanoparticles.webp")
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=durs, loop=0,
                   quality=72, method=6, lossless=False)
    frames[0].save(os.path.join(HERE, "nanoparticles-frame0.png"))
    print("nanoparticles.webp", frames[0].size, len(frames), "frames,", os.path.getsize(path) // 1024, "KB")
