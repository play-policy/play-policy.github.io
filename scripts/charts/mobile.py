"""Portrait variants of the chart videos for phones (python3 make_charts.py --mobile).

Canvas is 1080 px wide and shown at about 358 px, so 1 on-screen px is ~3 frame px:
text is never under 38 px, bars are ~46 px (about 15 px on screen). Same data, colors
and timing as the desktop charts; small multiples are stacked top to bottom.
"""
import data as D
import style as S
from style import (AXIS, HAIRLINE, INK, SECONDARY, SERIES, STAGE, TICK, ease_in_out, ease_out, fmt1, lin,
                   logx, prog)

W = 1080
MARGIN = 48
LABEL, HEAD, TICKS, AXIS_T, VALUE, STRONG = 40, 42, 38, 40, 40, 46
BAR, RADIUS, GRID, LINE, GAP = 46, 12, 3, 8, 6
DOT, RING = 17, 6


def _bar(c, x0, x1, y, color, round_end=True, z=2):
    c.hbar(x0, x1, y, color, thick=BAR, radius=RADIUS, round_end=round_end, z=z)


# ---------------------------------------------------------------- stacked small multiples
def stacked_bars(c, t, rows, headers, values, kinds, *, y_top, pitch=66, header_h=62, panel_gap=56,
                 first_row_extra=0, vmax=100, ticks=(0, 50, 100), panel_vmax=None, panel_ticks=None,
                 ticks_each_panel=False, fmt=fmt1, strong=None, axis_title="Success rate (%)",
                 start=0.3, row_stagger=0.08, panel_stagger=0.15, grow=1.0, value_room=None, extra=None,
                 tick_fmt=str):
    """Panels stacked vertically; method labels on the left of every panel."""
    if strong is None:
        def strong(r):
            return kinds[r] == "dsp"
    n_rows = len(rows)
    weights = ["semibold" if strong(r) else "regular" for r in range(n_rows)]
    label_w = max(c.measure(rows[r], LABEL, weights[r])[0] for r in range(n_rows))
    label_r = MARGIN + label_w
    x0 = label_r + 28
    if value_room is None:
        value_room = c.measure("00.0", STRONG, "semibold")[0] + 30
    bar_w = W - MARGIN - x0 - value_room
    geo = {"x0": x0, "bar_w": bar_w, "label_r": label_r, "panels": []}

    y = y_top
    for p, head in enumerate(headers):
        vm = panel_vmax[p] if panel_vmax else vmax
        tk = panel_ticks[p] if panel_ticks else ticks
        c.text(MARGIN, y, head, size=HEAD, color=SECONDARY, weight="medium")
        y_first = y + header_h + first_row_extra
        ys = [y_first + r * pitch for r in range(n_rows)]
        g_top, g_bot = ys[0] - pitch / 2 + 6, ys[-1] + pitch / 2 - 6
        for v in tk:
            gx = x0 + v / vm * bar_w
            c.vline(gx, g_top, g_bot, color=AXIS if v == 0 else HAIRLINE, width=GRID, z=1)
        last = p == len(headers) - 1
        if ticks_each_panel or last:
            for v in tk:
                c.text(x0 + v / vm * bar_w, g_bot + 40, tick_fmt(v), size=TICKS, color=TICK, ha="center")
        geo["panels"].append({"y": ys, "vmax": vm})
        for r in range(n_rows):
            yc = ys[r]
            c.text(label_r, yc, rows[r], size=LABEL, color=INK if strong(r) else SECONDARY, weight=weights[r],
                   ha="right")
            v = values[r][p]
            st = start + r * row_stagger + p * panel_stagger
            k = ease_out(prog(t, st, grow))
            x1 = x0 + v / vm * bar_w * k
            _bar(c, x0, x1, yc, SERIES[kinds[r]])
            a = prog(t, st + grow * 0.55, 0.25)
            lx = max(x1, x0) + 14
            if extra and "value_x" in extra:
                lx = extra["value_x"](r, p, vm, lx, geo)
            if strong(r):
                c.text(lx, yc, fmt(v), size=STRONG, color=INK, weight="semibold", alpha=a, halo=True)
            else:
                c.text(lx, yc, fmt(v), size=VALUE, color=SECONDARY, alpha=a, halo=True)
            if extra and "after" in extra:
                extra["after"](c, t, r, p, vm, yc, st, geo)
        y = g_bot + (96 if ticks_each_panel else 0) + panel_gap
    y_ticks_end = geo["panels"][-1]["y"][-1] + pitch / 2 + 40
    if axis_title:
        c.text(x0 + bar_w / 2, y_ticks_end + 66, axis_title, size=AXIS_T, color=SECONDARY, ha="center")
    geo["bottom"] = y_ticks_end + 66
    return geo


SHORT = {
    "DSP (ours)": "DSP (ours)",
    "Distilled policy (ours)": "Distilled (ours)",
    "Hindsight BC": "Hindsight BC",
    "Play policy": "Play policy",
    "Goal-conditioned BC": "Goal-cond. BC",
    "PPO, same 701K frames": "PPO, same frames",
    "Behavior cloning": "Behavior cloning",
    "RL, matched data": "RL, matched data",
    "DSP on hardware": "DSP on hardware",
    "Cube random walk, SO(3)": "Cube random walk",
    "Joint random walk": "Joint random walk",
}


# ---------------------------------------------------------------- 1
def sim_baselines():
    rows = [SHORT[d["label"]] for d in D.SIM_BASELINES]
    kinds = [d["kind"] for d in D.SIM_BASELINES]
    vals = [d["sr"] for d in D.SIM_BASELINES]

    def draw(c, t):
        stacked_bars(c, t, rows, D.THRESHOLDS, vals, kinds, y_top=74)

    return draw, W, 1640, 3.4


# ---------------------------------------------------------------- 2
def sim_efficiency():
    E = D.SIM_EFFICIENCY
    XL, XR, YT, YB = 150, 1000, 236, 1060
    pts = {p["label"]: p for p in E["points"]}

    def X(f):
        return logx(f, 1e5, 1e9, XL, XR)

    def Y(v):
        return lin(v, 0, 100, YB, YT)

    order = [("Hindsight BC", 0.25), ("PPO, same frames", 0.45), ("DSP", 0.65), ("PPO, 344M frames", 1.05)]

    def draw(c, t):
        for v in (0, 25, 50, 75):
            c.hline(XL, XR, Y(v), color=AXIS if v == 0 else HAIRLINE, width=GRID)
            c.text(XL - 22, Y(v), f"{v}", size=TICKS, color=TICK, ha="right")
        c.text(MARGIN, 110, "Success at 0.6 rad (%)", size=AXIS_T, color=SECONDARY)
        for f, s in ((1e5, "100K"), (1e6, "1M"), (1e7, "10M"), (1e8, "100M"), (1e9, "1B")):
            c.text(X(f), YB + 50, s, size=TICKS, color=TICK, ha="center")
        c.text((XL + XR) / 2, YB + 120, "Interaction frames (log scale)", size=AXIS_T, color=SECONDARY,
               ha="center")

        k = ease_in_out(prog(t, 2.55, 0.5))
        if k > 0:
            y = Y(E["ppo_unlimited_sr06"])
            c.hline(XL, XL + (XR - XL) * k, y, color=SERIES["ppo"], width=4, alpha=0.55, z=2)
            c.text(XR, y - 34, f"PPO, unlimited: {E['ppo_unlimited_sr06']:.1f}%", size=VALUE, color=SECONDARY,
                   ha="right", alpha=prog(t, 2.9, 0.3))

        xa, xb, ya = X(pts["DSP"]["frames"]), X(pts["PPO, 344M frames"]["frames"]), Y(68)
        k = ease_in_out(prog(t, 1.6, 0.8))
        if k > 0:
            lo, hi = xa + 30, xb - 30
            xe = lo + (hi - lo) * k
            c.hline(lo + 6, xe, ya, color=INK, width=4, z=4)
            c.arrowhead(lo, ya, -1, size=26, color=INK)
            c.arrowhead(hi if k >= 1 else xe + 6, ya, +1, size=26, color=INK)
            c.text((lo + hi) / 2, ya + 54, E["ratio_label"], size=STRONG, color=INK, weight="semibold",
                   ha="center", alpha=prog(t, 2.3, 0.3))

        for name, st in order:
            p = pts[name]
            x, y = X(p["frames"]), Y(p["sr06"])
            k = ease_out(prog(t, st, 0.35))
            col = SERIES[p["kind"]]
            if p["kind"] == "dsp":
                c.diamond(x, y, 24 * k, col, ring=RING)
            else:
                c.dot(x, y, DOT * k, col, ring=RING)
            a = prog(t, st + 0.15, 0.3)
            if name == "DSP":
                w = c.measure("DSP", STRONG, "semibold")[0]
                c.text(x + 40, y, "DSP", size=STRONG, color=INK, weight="semibold", alpha=a)
                c.text(x + 40 + w + 14, y, f"{p['sr06']:.1f}%", size=STRONG, color=INK, alpha=a)
            elif name == "PPO, 344M frames":
                c.text(XR, y + 52, f"PPO, 344M frames: {p['sr06']:.1f}%", size=VALUE, color=SECONDARY, ha="right",
                       alpha=a, halo=True)
            else:
                dy = -44 if p["sr06"] == 0 else 0
                c.text(x + 36, y + dy, f"{name}: {p['sr06']:.1f}%", size=VALUE, color=SECONDARY, alpha=a)

    return draw, W, 1240, 4.2


# ---------------------------------------------------------------- 3
def real_vs_sim():
    R = D.REAL_VS_SIM
    rows = [SHORT[d["label"]] for d in R["rows"]]
    kinds = [d["kind"] for d in R["rows"]]
    vals = [d["sr"] for d in R["rows"]]
    sim = R["dsp_sim"]

    def value_x(r, p, vm, lx, geo):
        if r != 0:
            return lx
        return max(lx, geo["x0"] + sim[p] / vm * geo["bar_w"] + 20)

    def after(c, t, r, p, vm, yc, st, geo):
        if r != 0:
            return
        a = prog(t, st + 1.0, 0.3)
        if a <= 0:
            return
        x = geo["x0"] + sim[p] / vm * geo["bar_w"]
        drop = (1 - ease_out(a)) * 18
        c.vline(x, yc - BAR / 2 - 14 - drop, yc + BAR / 2 + 14 - drop, color=INK, width=6, alpha=a, z=6)
        c.text(x, yc - BAR / 2 - 44 - drop, f"sim {sim[p]:.1f}", size=TICKS, color=SECONDARY, ha="center",
               alpha=a, halo=True)

    def draw(c, t):
        stacked_bars(c, t, rows, D.THRESHOLDS, vals, kinds, y_top=74, pitch=72, first_row_extra=46,
                     extra={"value_x": value_x, "after": after})

    return draw, W, 1420, 3.6


# ---------------------------------------------------------------- 4
def pusht():
    P = D.PUSHT
    rows = [SHORT[d["label"]] for d in P["rows"]]
    kinds = [d["kind"] for d in P["rows"]]
    vals = [d["sr"] for d in P["rows"]]

    def draw(c, t):
        stacked_bars(c, t, rows, P["headers"], vals, kinds, y_top=74, pitch=72, fmt=lambda v: f"{v:.0f}",
                     value_room=c.measure("000", STRONG, "semibold")[0] + 30)

    return draw, W, 1140, 3.4


# ---------------------------------------------------------------- 5
def rgb():
    G = D.RGB
    play, dsp = G["play"]["sr"], G["dsp"]["sr"]
    XL, XR = 100, 930
    ys = [214, 444, 674]
    g_top, g_bot = 104, 744

    def X(v):
        return lin(v, 0, 100, XL, XR)

    def draw(c, t):
        # series named directly under the first row's dots (no legend)
        c.text(X(play[0]) + DOT, ys[0] + 54, "Play policy alone", size=VALUE, color=SECONDARY, ha="right",
               alpha=prog(t, 0.45, 0.3), halo=True)
        c.text(X(dsp[0]) - DOT, ys[0] + 54, "DSP", size=VALUE, color=INK, weight="semibold", ha="left",
               alpha=prog(t, 1.9, 0.3), halo=True)

        for v in (0, 25, 50, 75, 100):
            c.vline(X(v), g_top, g_bot, color=AXIS if v == 0 else HAIRLINE, width=GRID)
            c.text(X(v), g_bot + 42, f"{v}", size=TICKS, color=TICK, ha="center")
        c.text((XL + XR) / 2, g_bot + 110, "Success rate (%)", size=AXIS_T, color=SECONDARY, ha="center")

        for i, h in enumerate(D.THRESHOLDS):
            y = ys[i]
            c.text(MARGIN, y - 104, h, size=LABEL, color=SECONDARY, weight="medium", halo=True)
            kp = ease_out(prog(t, 0.3 + 0.12 * i, 0.35))
            km = ease_out(prog(t, 1.0 + 0.15 * i, 0.9))
            xp = X(play[i])
            xd = xp + (X(dsp[i]) - xp) * km
            if km > 0:
                c.hline(xp, xd, y, color=SERIES["baseline2"], width=12, z=3)
            c.dot(xp, y, DOT * kp, SERIES["baseline"], ring=RING, z=4)
            if km > 0:
                c.dot(xd, y, DOT + 1, SERIES["dsp"], ring=RING, z=6)
            c.text(xp - 36, y, fmt1(play[i]), size=VALUE, color=SECONDARY, ha="right",
                   alpha=prog(t, 0.45 + 0.12 * i, 0.3), halo=True)
            a = prog(t, 1.0 + 0.15 * i + 0.75, 0.3)
            c.text(X(dsp[i]) + 36, y, fmt1(dsp[i]), size=STRONG, color=INK, weight="semibold", alpha=a, halo=True)
            c.text((xp + X(dsp[i])) / 2, y - 48, f"+{dsp[i] - play[i]:.1f} pp", size=VALUE, color=SECONDARY,
                   ha="center", alpha=a, halo=True)

    return draw, W, 900, 3.8


# ---------------------------------------------------------------- 6
def scaling():
    Sc = D.SCALING
    hrs, mae = Sc["hours"], Sc["mae_deg"]
    XL, XR, YT, YB = 150, 1000, 236, 980

    def X(h):
        return logx(h, 0.45, 6.2, XL, XR)

    def Y(v):
        return lin(v, 26, 40, YB, YT)

    xs, ys = [X(h) for h in hrs], [Y(v) for v in mae]
    t0, t1 = 0.6, 2.6

    def draw(c, t):
        for v in (28, 32, 36, 40):
            c.hline(XL, XR, Y(v), color=HAIRLINE, width=GRID)
            c.text(XL - 22, Y(v), f"{v}°", size=TICKS, color=TICK, ha="right")
        c.hline(XL, XR, YB, color=AXIS, width=GRID)
        c.text(MARGIN, 110, "Mean rotation error, 50 steps ahead (°)", size=AXIS_T, color=SECONDARY)
        for h, x in zip(hrs, xs):
            c.text(x, YB + 50, f"{h:.2f}", size=TICKS, color=TICK, ha="center")
        c.text((XL + XR) / 2, YB + 120, "Hours of autonomous play (log scale)", size=AXIS_T, color=SECONDARY,
               ha="center")

        a = prog(t, 0.15, 0.35)
        yb = Y(Sc["persistence_deg"])
        c.hline(XL, XR, yb, color=SERIES["baseline"], width=4, alpha=a, z=2)
        c.text(XL + 6, yb - 36, f"No-motion baseline: {Sc['persistence_deg']:.2f}°", size=VALUE, color=SECONDARY,
               alpha=a)

        k = ease_in_out(prog(t, t0, t1 - t0))
        if k > 0:
            xe = xs[0] + (xs[-1] - xs[0]) * k
            px, py = [xs[0]], [ys[0]]
            for i in range(1, len(xs)):
                if xs[i] <= xe:
                    px.append(xs[i])
                    py.append(ys[i])
                else:
                    f = (xe - xs[i - 1]) / (xs[i] - xs[i - 1])
                    px.append(xe)
                    py.append(ys[i - 1] + f * (ys[i] - ys[i - 1]))
                    break
            c.polyline(px, py, SERIES["dsp"], width=LINE, z=3)
            for i in range(len(xs)):
                if xs[i] <= xe + 0.5:
                    reach = t0 + (t1 - t0) * ((xs[i] - xs[0]) / (xs[-1] - xs[0]))
                    c.dot(xs[i], ys[i], 14 * ease_out(prog(t, reach - 0.05, 0.25)), SERIES["dsp"], ring=RING)
        c.text(xs[0], ys[0] + 60, f"{mae[0]:.2f}°", size=VALUE, color=SECONDARY, ha="center",
               alpha=prog(t, 0.75, 0.3), halo=True)
        c.text(xs[-1], ys[-1] - 60, f"{mae[-1]:.2f}°", size=STRONG, color=INK, weight="semibold", ha="center",
               alpha=prog(t, t1, 0.3), halo=True)
        c.text(xs[-1], ys[-1] + 60, Sc["reduction_label"], size=VALUE, color=SECONDARY, ha="center",
               alpha=prog(t, t1 + 0.15, 0.3), halo=True)

    return draw, W, 1160, 3.9


# ---------------------------------------------------------------- 7
def play_diversity():
    P = D.PLAY_DIVERSITY
    rows = P["rows"]
    kinds = ["dsp", "baseline"]
    measures = P["measures"]
    vals = [[m["values"][r] for m in measures] for r in rows]

    def draw(c, t):
        stacked_bars(c, t, rows, [m["header"] for m in measures], vals, kinds, y_top=74, pitch=72,
                           panel_gap=34, ticks_each_panel=True, axis_title=None,
                           panel_vmax=[m["max"] for m in measures], panel_ticks=[m["ticks"] for m in measures],
                           value_room=c.measure("000.0", STRONG, "semibold")[0] + 30, strong=lambda r: r == 0)

    return draw, W, 940, 3.2


# ---------------------------------------------------------------- 8
def latency():
    L = D.LATENCY
    XL, XR = 72, 1008
    total = L["replan_total_ms"]
    frame = 1000.0 / L["camera_fps"]
    sweep0, sweep1 = 0.3, 3.0
    y_title = [92, 380, 528]
    y_bar = [160, 446, 594]
    g_top, g_bot = 128, 626

    def X(ms):
        return lin(ms, 0, 160, XL, XR)

    def draw(c, t):
        for v in range(0, 161, 40):
            c.vline(X(v), g_top, g_bot, color=AXIS if v == 0 else HAIRLINE, width=GRID)
            c.text(X(v), g_bot + 44, f"{v}", size=TICKS, color=TICK, ha="center")
        c.text((XL + XR) / 2, g_bot + 110, "Time (ms)", size=AXIS_T, color=SECONDARY, ha="center")

        ms_now = 160 * ease_in_out(prog(t, sweep0, sweep1 - sweep0)) if t >= sweep0 else 0.0

        title = "Planner, one replan"
        c.text(XL, y_title[0], title, size=HEAD, color=INK, weight="semibold", halo=True)
        if ms_now >= total:
            tw = c.measure(title + ": ", HEAD, "semibold")[0]
            c.text(XL + tw, y_title[0], f"{total:.1f} ms", size=HEAD, color=INK, weight="semibold",
                   alpha=prog(ms_now, total, 6), halo=True)
        c.text(XL, y_title[1], f"Camera at 30 fps, tracking {L['tracking_ms']:.1f} ms per frame", size=LABEL,
               color=SECONDARY, halo=True)
        c.text(XL, y_title[2], "Hand", size=LABEL, color=SECONDARY, halo=True)

        acc, n = 0.0, len(L["planner"])
        for i, seg in enumerate(L["planner"]):
            s0, s1 = acc, acc + seg["ms"]
            acc = s1
            e = min(s1, ms_now)
            if e > s0:
                x0 = X(s0) + (GAP / 2 if i > 0 else 0)
                x1 = X(e) - (GAP / 2 if (i < n - 1 and e >= s1) else 0)
                _bar(c, x0, x1, y_bar[0], STAGE[seg["label"]], round_end=(i == n - 1), z=3)
            if ms_now >= s1 and seg["label"] != "Other":
                a = prog(ms_now, s1, 6)
                lx = X(s0) + (0 if i == 0 else 8)
                c.text(lx, y_bar[0] + BAR / 2 + 40, seg["label"], size=TICKS, color=SECONDARY, alpha=a,
                       halo=True)
                c.text(lx, y_bar[0] + BAR / 2 + 88, f"{seg['ms']:.1f} ms", size=TICKS, color=TICK, alpha=a,
                       halo=True)

        k = 0
        while k * frame < 160:
            f0 = k * frame
            if ms_now >= f0:
                c.vline(X(f0), y_bar[1] - BAR / 2 - 10, y_bar[1] + BAR / 2 + 10, color=S.MUTED, width=3, z=4)
                e = min(f0 + L["tracking_ms"], ms_now, 160)
                c.hbar(X(f0) + 4, X(e), y_bar[1], SECONDARY, thick=BAR, radius=RADIUS, z=3)
            k += 1

        if ms_now > 0:
            c.hbar(X(0), X(min(ms_now, 160)), y_bar[2], SERIES["baseline2"], thick=BAR, radius=RADIUS,
                   round_end=False, z=3)
            if ms_now > 110:
                c.text(X(0) + 22, y_bar[2], "keeps executing the current prefix", size=TICKS, color=INK,
                       alpha=prog(ms_now, 110, 25))

        a = 1 - prog(t, sweep1, 0.3)
        if t >= sweep0 and a > 0:
            c.vline(X(ms_now), g_top, g_bot, color=INK, width=4, alpha=a, z=7)

    return draw, W, 800, 4.2


CHARTS = {
    "sim_baselines": sim_baselines,
    "sim_efficiency": sim_efficiency,
    "real_vs_sim": real_vs_sim,
    "pusht": pusht,
    "rgb": rgb,
    "scaling": scaling,
    "play_diversity": play_diversity,
    "latency": latency,
}
