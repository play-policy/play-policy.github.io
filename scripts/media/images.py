"""Posters, gallery thumbnails and stills for the DSP site.

usage: python3 -I images.py POSTER_TMP SRC_MEDIA_DIR PAPER_IMGS_DIR SITE_DIR
POSTER_TMP holds PNG frames grabbed from the encoded videos by build_media.sh.
"""
import os
import sys

from PIL import Image

poster_tmp, src, paper, site = sys.argv[1:5]
posters = os.path.join(site, "static", "posters")
images = os.path.join(site, "static", "images")
os.makedirs(os.path.join(posters, "thumbs"), exist_ok=True)
os.makedirs(images, exist_ok=True)


def save_jpg(im, path, quality):
    im.convert("RGB").save(path, "JPEG", quality=quality, optimize=True, progressive=True)


def save_png(im, path):
    im.save(path, "PNG", optimize=True)


# Posters and thumbnails.
for fn in sorted(os.listdir(poster_tmp)):
    name, ext = os.path.splitext(fn)
    if ext != ".png" or name.startswith("og_"):
        continue
    im = Image.open(os.path.join(poster_tmp, fn))
    # MPC explainer stills (first and last frames) sit next to each other on white; keep them cleaner.
    save_jpg(im, os.path.join(posters, name + ".jpg"), 88 if name.startswith("mpc_") else 80)
    if name.startswith("real_"):
        w = 360
        thumb = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        save_jpg(thumb, os.path.join(posters, "thumbs", name + ".jpg"), 78)

# Paper Fig. 1 pipeline figure (deck image9.png), full resolution.
fig = Image.open(os.path.join(src, "image9.png"))
if fig.mode == "RGBA" and fig.getchannel("A").getextrema() == (255, 255):
    fig = fig.convert("RGB")
save_png(fig, os.path.join(images, "pipeline.png"))

# Hardware photo behind paper Fig. 6 (labels were vector text in the PDF, so the photo is clean).
setup = Image.open(os.path.join(paper, "p6_x121.png")).convert("RGB")
setup = setup.resize((1600, round(setup.height * 1600 / setup.width)), Image.LANCZOS)
save_jpg(setup, os.path.join(images, "setup.jpg"), 85)

# Goal cube from deck slide 13 (transparent background).
save_png(Image.open(os.path.join(src, "image20.png")), os.path.join(images, "mpc_goal.png"))

# Paper Fig. 9 (Push-T planning): two square panels inside a 17 px gray frame.
# Panel interiors measured on the 3497x1723 source: x 26..1697 and 1801..3472, y 26..1697.
pusht = Image.open(os.path.join(paper, "p7_x139.png")).convert("RGB")
for name, box in (("pusht_plan_propose", (26, 26, 1698, 1698)),
                  ("pusht_plan_predict", (1801, 26, 3473, 1698))):
    panel = pusht.crop(box).resize((1200, 1200), Image.LANCZOS)
    # Flat renders: an adaptive 256-color palette is visually lossless and much smaller.
    panel = panel.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    save_png(panel, os.path.join(images, name + ".png"))

# Social card, 1200x630, no text: human play (left) and the end of real_01 (right), 4 px dark gap.
left = Image.open(os.path.join(poster_tmp, "og_left.png")).convert("RGB")   # 1280x720
right = Image.open(os.path.join(poster_tmp, "og_right.png")).convert("RGB")  # 1280x720
half = (598, 630)
left = left.crop((200, 0, 886, 720)).resize(half, Image.LANCZOS)    # glove + robot hand with cube
right = right.crop((273, 0, 959, 720)).resize(half, Image.LANCZOS)  # hand + cube, left of the HUD panel
og = Image.new("RGB", (1200, 630), (11, 11, 11))
og.paste(left, (0, 0))
og.paste(right, (602, 0))
save_jpg(og, os.path.join(images, "og.jpg"), 85)

print("images: posters, thumbs, pipeline.png, setup.jpg, mpc_goal.png, pusht_plan_*.png, og.jpg")
