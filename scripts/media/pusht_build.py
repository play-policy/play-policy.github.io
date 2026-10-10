"""Turn the two Push-T planning panels (paper Fig. 9) into short build-up videos.

No new data is drawn: every trajectory mark already in the figure starts as a faint ghost of
itself and lights up to full strength in order: proposals (or predicted block motion) first,
spreading out from the pusher, then the selected plan in yellow. The last frame is the
original panel, pixel for pixel.

usage: python3 -I scripts/media/pusht_build.py SITE_DIR
"""
import colorsys
import os
import subprocess
import sys

import numpy as np
from PIL import Image

FFMPEG = os.environ.get("FFMPEG", "/opt/homebrew/bin/ffmpeg")
FPS, OUT = 30, 720
T_BASE, T_L1, T_GAP, T_L2, T_HOLD = 0.4, 1.6, 0.2, 1.0, 1.0


def hsv(img):
    f = img.astype(np.float32) / 255.0
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    mx, mn = f.max(-1), f.min(-1)
    d = mx - mn + 1e-6
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    s = np.where(mx > 0, d / (mx + 1e-6), 0)
    return h, s, mx


def dilate(m, r):
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r:
                out |= np.roll(np.roll(m, dy, 0), dx, 1)
    return out


def inpaint(img, mask, iters=400):
    """Fill masked pixels by repeated averaging of known neighbors (diffusion fill)."""
    f = img.astype(np.float32)
    known = ~mask
    f[mask] = 0
    for _ in range(iters):
        if known.all():
            break
        acc = np.zeros_like(f)
        cnt = np.zeros(mask.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            k = np.roll(np.roll(known, dy, 0), dx, 1)
            acc += np.roll(np.roll(f, dy, 0), dx, 1) * k[..., None]
            cnt += k
        grow = (~known) & (cnt > 0)
        f[grow] = acc[grow] / cnt[grow][:, None]
        known = known | grow
    return f


def ease(x):
    x = np.clip(x, 0, 1)
    return 1 - (1 - x) ** 3


def layers(img, kind):
    h, s, v = hsv(img)
    H, W = v.shape
    yy, xx = np.mgrid[0:H, 0:W]
    yellow = (h > 38) & (h < 62) & (s > 0.35) & (v > 0.6)
    dark = (v < 0.32) & (s < 0.45)
    yellow_all = yellow | (dark & dilate(yellow, 7))
    if kind == "propose":
        l1 = (h > 4) & (h < 33) & (s > 0.16) & (v > 0.55) & ~yellow_all
    else:
        l1 = (h > 195) & (h < 235) & (s > 0.30) & (v > 0.5) & (xx > 330) & ~yellow_all  # gray T is s~0.22
    return dilate(l1, 1), dilate(yellow_all, 1)


def reveal_field(shape, kind):
    H, W = shape
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    if kind == "propose":
        cy, cx = 606.0, 246.0  # pusher start in the 1200 px panel
        return np.hypot(yy - cy, xx - cx) / 450.0
    return (xx - 360.0) / 300.0  # left-to-right wipe across the predictions


def build(src, dst_mp4, dst_poster, kind):
    img = np.array(Image.open(src).convert("RGB"))
    l1, l2 = layers(img, kind)
    orig = img.astype(np.float32)
    # Ghost = the mark itself at ~28 % strength over white; nothing underneath is guessed.
    ghost = orig * 0.28 + 255.0 * 0.72
    base = np.where((l1 | l2)[..., None], ghost, orig)
    field = reveal_field(l1.shape, kind)
    soft = 0.06
    n = int(round((T_BASE + T_L1 + T_GAP + T_L2 + T_HOLD) * FPS))
    cmd = [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{OUT}x{OUT}",
           "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "20",
           "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709",
           "-colorspace", "bt709", "-movflags", "+faststart", "-an", dst_mp4]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    last = None
    for i in range(n):
        t = i / FPS
        p1 = ease((t - T_BASE) / T_L1)
        p2 = ease((t - T_BASE - T_L1 - T_GAP) / T_L2)
        a1 = np.clip((p1 * (1 + soft) - field) / soft, 0, 1) * l1
        a2 = np.clip((p2 * (1 + soft) - (field if kind == "predict" else field * 0.75)) / soft, 0, 1) * l2
        a = np.maximum(a1, a2)[..., None]
        if p1 >= 1 and p2 >= 1:
            frame = orig
        else:
            frame = base * (1 - a) + orig * a
        im = Image.fromarray(np.clip(frame, 0, 255).astype(np.uint8)).resize((OUT, OUT), Image.LANCZOS)
        p.stdin.write(im.tobytes())
        last = im
    p.stdin.close()
    if p.wait() != 0:
        raise SystemExit(f"ffmpeg failed for {dst_mp4}")
    last.save(dst_poster, quality=88)
    print(dst_mp4, n, "frames;", "layer1 px", int(l1.sum()), "layer2 px", int(l2.sum()))


def main():
    site = sys.argv[1]
    for kind in ("propose", "predict"):
        build(os.path.join(site, f"static/images/pusht_plan_{kind}.png"),
              os.path.join(site, f"static/videos/pusht_plan_{kind}.mp4"),
              os.path.join(site, f"static/posters/pusht_plan_{kind}.jpg"), kind)


if __name__ == "__main__":
    main()
