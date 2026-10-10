"""Drawing helpers for the DSP chart videos.

Every chart is drawn on a pixel canvas (origin top-left, 1 unit = 1 output pixel),
one frame at a time, and piped to ffmpeg. Sizes below are output pixels for a
1600 px wide frame that the page shows at roughly 760 px, so divide by ~2.1 to get
on-screen pixels (44 px bars show as ~21 px, 26 px text as ~12 px).
"""
import glob
import math
import os
import shutil
import subprocess

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.patches import Circle, PathPatch, Polygon, Rectangle  # noqa: E402
from matplotlib.path import Path  # noqa: E402
from PIL import Image  # noqa: E402

DPI = 100
PT = 72.0 / DPI  # points per output pixel

# Design tokens (SPEC section 6). Text never takes a series color.
INK = "#16181a"
SECONDARY = "#50555b"
MUTED = "#858b91"
TICK = "#6c7278"   # tick labels: muted token darkened to 4.9:1 on white for ~12 px on-screen text
HAIRLINE = "#e3e5e8"
AXIS = "#c6cacf"
SURFACE = "#ffffff"

SERIES = {
    "dsp": "#0072b2",       # DSP, ours
    "distill": "#56a7e0",   # distilled policy, ours (validator-adjusted from #7db8de)
    "ppo": "#d55e00",       # PPO / RL
    "baseline": "#a3a8ad",  # imitation baselines and play policy
    "baseline2": "#c4c8cc", # random walks (weakest baselines)
}
# Planner stages in the latency chart, hue-matched to pipeline stages 1, 3, 4.
STAGE = {"Play policy": "#6a4c9c", "World model": "#3987e5", "Scoring": "#3a9a4c", "Other": "#c4c8cc"}

# Text sizes in output px.
T_LABEL = 30      # row labels
T_HEAD = 30       # facet headers
T_TICK = 26       # tick labels
T_AXIS = 27       # axis titles
T_VALUE = 27      # muted value labels
T_STRONG = 32     # emphasized value labels

BAR = 44          # bar thickness
RADIUS = 8        # rounded data end
GRID_W = 2        # hairline width
LINE_W = 5        # data line width
GAP = 4           # surface gap between touching marks

FONT_FAMILY = "IBM Plex Sans"
_FONT_USED = None


def setup_fonts(font_dir):
    """Register IBM Plex Sans from font_dir. Returns the family actually used."""
    global _FONT_USED
    paths = sorted(glob.glob(os.path.join(font_dir, "IBMPlexSans-*.ttf"))) if font_dir else []
    for p in paths:
        font_manager.fontManager.addfont(p)
    family = FONT_FAMILY if paths else "Helvetica"
    plt.rcParams.update({
        "font.family": family,
        "font.size": 20,
        "text.antialiased": True,
        "lines.antialiased": True,
        "patch.antialiased": True,
        "lines.solid_capstyle": "round",
        "lines.solid_joinstyle": "round",
    })
    _FONT_USED = family
    return family


def font_used():
    return _FONT_USED


# ---------------------------------------------------------------- easing
def clamp01(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def ease_out(x):
    x = clamp01(x)
    return 1 - (1 - x) ** 3


def ease_in_out(x):
    x = clamp01(x)
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def prog(t, start, dur):
    """Linear 0..1 progress of an animation that starts at `start` and lasts `dur` seconds."""
    if dur <= 0:
        return 1.0 if t >= start else 0.0
    return clamp01((t - start) / dur)


# ---------------------------------------------------------------- canvas
class Canvas:
    def __init__(self, width, height):
        self.W, self.H = width, height
        # +0.25 px guards against float truncation (16.4 in x 100 dpi -> 1639 px)
        self.fig = plt.figure(figsize=((width + 0.25) / DPI, (height + 0.25) / DPI), dpi=DPI, facecolor=SURFACE)
        got = tuple(int(v) for v in self.fig.canvas.get_width_height())
        if got != (width, height):
            raise RuntimeError(f"canvas is {got}, expected {(width, height)}")
        self.ax = self.fig.add_axes([0, 0, 1, 1])
        self._renderer = None
        self.reset()

    def reset(self):
        ax = self.ax
        ax.cla()
        ax.set_xlim(0, self.W)
        ax.set_ylim(self.H, 0)
        ax.set_axis_off()
        ax.set_facecolor(SURFACE)

    # -- measuring
    def measure(self, s, size, weight="regular"):
        """Rendered (width, height) of a string in output px."""
        if self._renderer is None:
            self.fig.canvas.draw()
            self._renderer = self.fig.canvas.get_renderer()
        t = self.ax.text(0, 0, s, fontsize=size * PT, fontweight=weight)
        bb = t.get_window_extent(renderer=self._renderer)
        t.remove()
        return bb.width, bb.height

    # -- primitives
    def text(self, x, y, s, size=T_LABEL, color=INK, weight="regular", ha="left", va="center", alpha=1.0,
             halo=False, **kw):
        """Text in output px. halo=True masks gridlines behind the label with the surface color."""
        if alpha <= 0:
            return None
        if halo:
            kw["bbox"] = dict(boxstyle="square,pad=0.12", facecolor=SURFACE, edgecolor="none", alpha=alpha)
            kw.setdefault("zorder", 6)
        return self.ax.text(x, y, s, fontsize=size * PT, color=color, fontweight=weight,
                            ha=ha, va=va, alpha=alpha, **kw)

    def hline(self, x0, x1, y, color=HAIRLINE, width=GRID_W, alpha=1.0, z=1):
        y = round(y)
        self.ax.plot([x0, x1], [y, y], color=color, linewidth=width * PT, alpha=alpha,
                     solid_capstyle="butt", zorder=z)

    def vline(self, x, y0, y1, color=HAIRLINE, width=GRID_W, alpha=1.0, z=1):
        x = round(x)
        self.ax.plot([x, x], [y0, y1], color=color, linewidth=width * PT, alpha=alpha,
                     solid_capstyle="butt", zorder=z)

    def polyline(self, xs, ys, color, width=LINE_W, alpha=1.0, z=3):
        self.ax.plot(xs, ys, color=color, linewidth=width * PT, alpha=alpha,
                     solid_capstyle="round", solid_joinstyle="round", zorder=z)

    def rect(self, x0, y0, x1, y1, color, alpha=1.0, z=2):
        if x1 <= x0 or y1 <= y0:
            return
        self.ax.add_patch(Rectangle((x0, y0), x1 - x0, y1 - y0, facecolor=color, edgecolor="none",
                                    alpha=alpha, zorder=z))

    def hbar(self, x0, x1, yc, color, thick=BAR, radius=RADIUS, round_end=True, alpha=1.0, z=2):
        """Horizontal bar from baseline x0 to data end x1, square at x0, rounded at x1."""
        length = x1 - x0
        if length <= 0.5:
            return
        top, bot = yc - thick / 2, yc + thick / 2
        r = min(radius, length, thick / 2) if round_end else 0
        k = 0.5523 * r
        if r <= 0.5:
            self.rect(x0, top, x1, bot, color, alpha, z)
            return
        verts = [
            (x0, top), (x1 - r, top),
            (x1 - r + k, top), (x1, top + r - k), (x1, top + r),
            (x1, bot - r),
            (x1, bot - r + k), (x1 - r + k, bot), (x1 - r, bot),
            (x0, bot), (x0, top),
        ]
        codes = [Path.MOVETO, Path.LINETO,
                 Path.CURVE4, Path.CURVE4, Path.CURVE4,
                 Path.LINETO,
                 Path.CURVE4, Path.CURVE4, Path.CURVE4,
                 Path.LINETO, Path.CLOSEPOLY]
        self.ax.add_patch(PathPatch(Path(verts, codes), facecolor=color, edgecolor="none",
                                    alpha=alpha, zorder=z))

    def dot(self, x, y, r, color, ring=4, ring_color=SURFACE, alpha=1.0, z=5):
        if r <= 0 or alpha <= 0:
            return
        if ring > 0:
            self.ax.add_patch(Circle((x, y), r + ring, facecolor=ring_color, edgecolor="none",
                                     alpha=alpha, zorder=z))
        self.ax.add_patch(Circle((x, y), r, facecolor=color, edgecolor="none", alpha=alpha, zorder=z + 0.1))

    def diamond(self, x, y, r, color, ring=4, ring_color=SURFACE, alpha=1.0, z=5):
        if r <= 0 or alpha <= 0:
            return
        if ring > 0:
            R = r + ring * 1.4
            self.ax.add_patch(Polygon([(x, y - R), (x + R, y), (x, y + R), (x - R, y)], closed=True,
                                      facecolor=ring_color, edgecolor="none", alpha=alpha, zorder=z))
        self.ax.add_patch(Polygon([(x, y - r), (x + r, y), (x, y + r), (x - r, y)], closed=True,
                                  facecolor=color, edgecolor="none", alpha=alpha, zorder=z + 0.1))

    def arrowhead(self, x, y, direction, size=16, color=INK, alpha=1.0, z=4):
        """Filled triangular head with its tip at (x, y); direction +1 points right, -1 left."""
        d = direction
        pts = [(x, y), (x - d * size, y - size * 0.55), (x - d * size, y + size * 0.55)]
        self.ax.add_patch(Polygon(pts, closed=True, facecolor=color, edgecolor="none", alpha=alpha, zorder=z))


# ---------------------------------------------------------------- scales
def lin(v, v0, v1, p0, p1):
    return p0 + (v - v0) / (v1 - v0) * (p1 - p0)


def logx(v, v0, v1, p0, p1):
    return p0 + (math.log10(v) - math.log10(v0)) / (math.log10(v1) - math.log10(v0)) * (p1 - p0)


def fmt1(v):
    return f"{v:.1f}"


# ---------------------------------------------------------------- render loop
def ffmpeg_bin():
    return shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


def render(draw, width, height, duration, out_mp4, out_jpg, fps=30, crf=18, n_frames=None, intra=False,
           poster_frame=-1):
    """Draw every frame with draw(canvas, t) and encode it. The last frame becomes the poster."""
    canvas = Canvas(width, height)
    n = n_frames if n_frames is not None else int(round(duration * fps))
    gop = ["-g", "1", "-bf", "0", "-x264-params", "keyint=1:min-keyint=1:scenecut=0"] if intra else []
    cmd = [
        ffmpeg_bin(), "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
        "-an", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
        "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", str(crf), *gop,
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-movflags", "+faststart", "-tag:v", "avc1", out_mp4,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    last = None
    keep = None
    want = poster_frame % n
    try:
        for i in range(n):
            t = i / fps
            canvas.reset()
            draw(canvas, t)
            canvas.fig.canvas.draw()
            buf = bytes(canvas.fig.canvas.buffer_rgba())
            if len(buf) != width * height * 4:
                raise RuntimeError(f"frame buffer is {len(buf)} bytes, expected {width * height * 4}")
            proc.stdin.write(buf)
            last = buf
            if i == want:
                keep = buf
    finally:
        proc.stdin.close()
        proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for {out_mp4}")
    Image.frombuffer("RGBA", (width, height), keep or last, "raw", "RGBA", 0, 1).convert("RGB").save(
        out_jpg, quality=90, optimize=True, progressive=True)
    plt.close(canvas.fig)
    return n
