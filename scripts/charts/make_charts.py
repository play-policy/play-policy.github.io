"""Render the DSP result charts as short MP4 videos plus a poster (final frame) each.

Usage:
    python3 scripts/charts/make_charts.py --fonts /path/to/ibm-plex-sans-ttfs [--chart NAME|all]

Writes static/charts/<name>.mp4, static/charts/<name>.jpg and static/charts/charts.json.
All numbers live in data.py.
"""
import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import data as D  # noqa: E402
import style as S  # noqa: E402
from style import (AXIS, BAR, GAP, GRID_W, HAIRLINE, INK, MUTED, SECONDARY, SERIES, STAGE, TICK,  # noqa: E402
                   T_AXIS, T_HEAD, T_LABEL, T_STRONG, T_TICK, T_VALUE, ease_in_out, ease_out, fmt1,
                   lin, logx, prog)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "static", "charts"))
MARGIN = 56


# ---------------------------------------------------------------- shared: faceted horizontal bars
def faceted_bars(c, t, rows, headers, values, kinds, *, vmax=100, ticks=(0, 50, 100), fmt=fmt1,
                 y_header, y0, pitch, axis_title="Success rate (%)", strong=None,
                 start=0.3, row_stagger=0.08, panel_stagger=0.15, grow=1.0, label_gap=40, panel_gap=48,
                 value_room=None, extra=None, panel_vmax=None, panel_ticks=None, tick_fmt=str):
    """Small multiples of horizontal bars: one panel per column of `values`, rows share labels."""
    n_rows, n_pan = len(rows), len(headers)
    if strong is None:
        def strong(r):
            return kinds[r] == "dsp"
    weights = ["semibold" if strong(r) else "regular" for r in range(n_rows)]
    label_w = max(c.measure(rows[r], T_LABEL, weights[r])[0] for r in range(n_rows))
    label_r = MARGIN + label_w
    p0 = label_r + label_gap
    pw = (c.W - MARGIN - p0 - panel_gap * (n_pan - 1)) / n_pan
    if value_room is None:
        value_room = c.measure("00.0", T_STRONG, "semibold")[0] + 24
    bar_w = pw - value_room
    y_last = y0 + pitch * (n_rows - 1)
    g_top, g_bot = y0 - pitch / 2 + 8, y_last + pitch / 2 - 8
    y_ticks = g_bot + 30

    geo = {"label_r": label_r, "p0": p0, "pw": pw, "bar_w": bar_w, "panels": []}
    for p in range(n_pan):
        x0 = p0 + p * (pw + panel_gap)
        vm = panel_vmax[p] if panel_vmax else vmax
        tk = panel_ticks[p] if panel_ticks else ticks
        geo["panels"].append((x0, vm))
        c.text(x0, y_header, headers[p], size=T_HEAD, color=SECONDARY, weight="medium", ha="left")
        for v in tk:
            x = x0 + v / vm * bar_w
            c.vline(x, g_top, g_bot, color=AXIS if v == 0 else HAIRLINE, width=GRID_W, z=1)
            c.text(x, y_ticks, tick_fmt(v), size=T_TICK, color=TICK, ha="center")

    for r in range(n_rows):
        yc = y0 + r * pitch
        c.text(label_r, yc, rows[r], size=T_LABEL, color=INK if strong(r) else SECONDARY,
               weight=weights[r], ha="right")
        for p in range(n_pan):
            x0, vm = geo["panels"][p]
            v = values[r][p]
            st = start + r * row_stagger + p * panel_stagger
            k = ease_out(prog(t, st, grow))
            x1 = x0 + v / vm * bar_w * k
            c.hbar(x0, x1, yc, SERIES[kinds[r]], z=2)
            a = prog(t, st + grow * 0.55, 0.25)
            lx = max(x1, x0) + 12
            if extra and "value_x" in extra:
                lx = extra["value_x"](r, p, x0, vm, lx, geo)
            if strong(r):
                c.text(lx, yc, fmt(v), size=T_STRONG, color=INK, weight="semibold", alpha=a, halo=True)
            else:
                c.text(lx, yc, fmt(v), size=T_VALUE, color=SECONDARY, alpha=a, halo=True)
            if extra and "after" in extra:
                extra["after"](c, t, r, p, x0, vm, yc, st, geo)
    if axis_title:
        mid = p0 + (c.W - MARGIN - p0) / 2
        c.text(mid, y_ticks + 52, axis_title, size=T_AXIS, color=SECONDARY, ha="center")
    return geo


# ---------------------------------------------------------------- 1 sim_baselines
def chart_sim_baselines():
    rows = [d["label"] for d in D.SIM_BASELINES]
    kinds = [d["kind"] for d in D.SIM_BASELINES]
    vals = [d["sr"] for d in D.SIM_BASELINES]

    def draw(c, t):
        faceted_bars(c, t, rows, D.THRESHOLDS, vals, kinds, y_header=118, y0=200, pitch=98)

    meta = {
        "columns": ["Method"] + D.THRESHOLDS,
        "rows": [[d["label"]] + d["sr"] for d in D.SIM_BASELINES],
        "decimals": [None, 1, 1, 1],
        "unit": "Success rate (%) at each goal threshold",
        "notes": "Simulated in-hand reorientation (Isaac Lab), 128 seeded trials, start-goal error over 90°. "
                 "Hindsight BC and PPO use the same 701K interaction frames as DSP; goal-conditioned BC uses 15 min "
                 "of goal-directed teleoperation.",
    }
    return draw, 1600, 900, 3.4, meta


# ---------------------------------------------------------------- 2 sim_efficiency
def chart_sim_efficiency():
    E = D.SIM_EFFICIENCY
    XL, XR, YT, YB = 250, 1390, 150, 740
    F0, F1 = 1e5, 1e9

    def X(f):
        return logx(f, F0, F1, XL, XR)

    def Y(v):
        return lin(v, 0, 100, YB, YT)

    pts = {p["label"]: p for p in E["points"]}
    order = [("Hindsight BC", 0.25), ("PPO, same frames", 0.45), ("DSP", 0.65), ("PPO, 344M frames", 1.05)]

    def draw(c, t):
        for v in (0, 25, 50, 75):
            c.hline(XL, XR, Y(v), color=AXIS if v == 0 else HAIRLINE)
            c.text(XL - 18, Y(v), f"{v}", size=T_TICK, color=TICK, ha="right")
        c.text(XL - 18 - c.measure("75", T_TICK)[0], YT - 60, "Success at 0.6 rad (%)", size=T_AXIS,
               color=SECONDARY, ha="left")
        for f, s in ((1e5, "100K"), (1e6, "1M"), (1e7, "10M"), (1e8, "100M"), (1e9, "1B")):
            c.text(X(f), YB + 38, s, size=T_TICK, color=TICK, ha="center")
        c.text((XL + XR) / 2, YB + 92, "Interaction frames (log scale)", size=T_AXIS, color=SECONDARY,
               ha="center")

        # PPO with unlimited frames: reference line, drawn last in the sequence
        k = ease_in_out(prog(t, 2.55, 0.5))
        if k > 0:
            y = Y(E["ppo_unlimited_sr06"])
            c.hline(XL, XL + (XR - XL) * k, y, color=SERIES["ppo"], width=3, alpha=0.55, z=2)
            c.text(XR, y - 24, f"PPO, unlimited frames: {E['ppo_unlimited_sr06']:.1f}%", size=T_VALUE,
                   color=SECONDARY, ha="right", alpha=prog(t, 2.9, 0.3))

        # 490x arrow from DSP to PPO at 344M frames
        xa, xb, ya = X(pts["DSP"]["frames"]), X(pts["PPO, 344M frames"]["frames"]), Y(70)
        k = ease_in_out(prog(t, 1.6, 0.8))
        if k > 0:
            lo, hi = xa + 24, xb - 24
            xe = lo + (hi - lo) * k
            c.vline(xa, Y(pts["DSP"]["sr06"]) + 26, ya + 14, color=AXIS, width=2, alpha=min(1, k * 3))
            c.hline(lo + 4, xe, ya, color=INK, width=3, z=4)
            c.arrowhead(lo, ya, -1, size=18, color=INK)
            if k >= 1:
                c.vline(xb, Y(pts["PPO, 344M frames"]["sr06"]) + 26, ya + 14, color=AXIS, width=2)
                c.arrowhead(hi, ya, +1, size=18, color=INK)
            else:
                c.arrowhead(xe + 4, ya, +1, size=18, color=INK)
            c.text((lo + hi) / 2, ya + 36, E["ratio_label"], size=T_STRONG, color=INK, weight="semibold",
                   ha="center", alpha=prog(t, 2.3, 0.3))

        for name, st in order:
            p = pts[name]
            x, y = X(p["frames"]), Y(p["sr06"])
            k = ease_out(prog(t, st, 0.35))
            col = SERIES[p["kind"]]
            if p["kind"] == "dsp":
                c.diamond(x, y, 17 * k, col, ring=4)
            else:
                c.dot(x, y, 12 * k, col, ring=4)
            a = prog(t, st + 0.15, 0.3)
            if name == "PPO, 344M frames":
                c.text(x + 28, y - 17, "PPO, 344M frames", size=T_VALUE, color=SECONDARY, alpha=a, halo=True)
                c.text(x + 28, y + 17, f"{p['sr06']:.1f}%", size=T_VALUE, color=SECONDARY, alpha=a, halo=True)
            elif name == "DSP":
                w = c.measure("DSP", T_STRONG, "semibold")[0]
                c.text(x + 30, y, "DSP", size=T_STRONG, color=INK, weight="semibold", alpha=a)
                c.text(x + 30 + w + 12, y, f"{p['sr06']:.1f}% at 701K frames", size=T_STRONG, color=INK,
                       alpha=a)
            else:
                dy = -30 if p["sr06"] == 0 else 0
                c.text(x + 28, y + dy, f"{name}: {p['sr06']:.1f}%", size=T_VALUE, color=SECONDARY, alpha=a)

    meta = {
        "columns": ["Method", "Interaction frames", "Success at 0.6 rad (%)"],
        "decimals": [None, 0, 1],
        "unit": "Interaction frames used for training, success rate (%)",
        "rows": [["DSP", 701000, 91.4], ["Hindsight BC", 701000, 53.9], ["PPO, same frames", 701000, 0.0],
                 ["PPO, 344M frames", 344000000, 86.7], ["PPO, unlimited frames", None, 96.9]],
        "notes": "344M / 701K ≈ 490. PPO with unlimited frames is an upper bound drawn as a reference line "
                 "(no frame count; null in the frames column).",
    }
    return draw, 1600, 900, 4.2, meta


# ---------------------------------------------------------------- 3 real_vs_sim
def chart_real_vs_sim():
    R = D.REAL_VS_SIM
    rows = [d["label"] for d in R["rows"]]
    kinds = [d["kind"] for d in R["rows"]]
    vals = [d["sr"] for d in R["rows"]]
    sim = R["dsp_sim"]

    def value_x(r, p, x0, vm, lx, geo):
        if r != 0:
            return lx
        return max(lx, x0 + sim[p] / vm * geo["bar_w"] + 16)

    def after(c, t, r, p, x0, vm, yc, st, geo):
        if r != 0:
            return
        bw = geo["bar_w"]
        a = prog(t, st + 1.0, 0.3)
        if a <= 0:
            return
        x = x0 + sim[p] / vm * bw
        drop = (1 - ease_out(a)) * 14
        c.vline(x, yc - BAR / 2 - 10 - drop, yc + BAR / 2 + 10 - drop, color=INK, width=4, alpha=a, z=6)
        c.text(x, yc - BAR / 2 - 34 - drop, f"sim {sim[p]:.1f}", size=T_STRONG, color=SECONDARY, ha="center",
               alpha=a, halo=True)

    def draw(c, t):
        faceted_bars(c, t, rows, D.THRESHOLDS, vals, kinds, y_header=140, y0=268, pitch=122,
                     extra={"value_x": value_x, "after": after})

    meta = {
        "columns": ["Controller"] + D.THRESHOLDS,
        "rows": [[d["label"]] + d["sr"] for d in R["rows"]] + [["DSP in simulation (reference)"] + sim],
        "decimals": [None, 1, 1, 1],
        "unit": "Success rate (%) at each goal threshold",
        "notes": "Sharpa hand on a Tianji Marvin M6 arm, 120 s per trial. The cube random walk on SO(3) matches "
                 "the play policy's angular speed. Hardware DSP stays within 4.1 points of simulation.",
    }
    return draw, 1600, 900, 3.6, meta


# ---------------------------------------------------------------- 4 pusht
def chart_pusht():
    P = D.PUSHT
    rows = [d["label"] for d in P["rows"]]
    kinds = [d["kind"] for d in P["rows"]]
    vals = [d["sr"] for d in P["rows"]]

    def draw(c, t):
        faceted_bars(c, t, rows, P["headers"], vals, kinds, fmt=lambda v: f"{v:.0f}", y_header=146, y0=236,
                     pitch=104, panel_gap=72)

    meta = {
        "columns": ["Controller", "Overlap ≥ 0.90", "Overlap ≥ 0.95", "Mean coverage"],
        "rows": [[d["label"]] + d["sr"] + [d["coverage"]] for d in P["rows"]],
        "decimals": [None, 0, 0, 3],
        "unit": "Success rate (%) at each overlap threshold; coverage is mean mask overlap (0 to 1)",
        "notes": "Push-T with a fixed 10k-frame teleoperation budget. Success means the T-block mask overlaps "
                 "the target by at least the threshold.",
    }
    return draw, 1600, 900, 3.4, meta


# ---------------------------------------------------------------- 5 rgb
def chart_rgb():
    G = D.RGB
    play, dsp = G["play"]["sr"], G["dsp"]["sr"]

    def draw(c, t):
        label_w = max(c.measure(h, T_LABEL, "regular")[0] for h in D.THRESHOLDS)
        label_r = MARGIN + label_w
        XL, XR = label_r + 70, c.W - MARGIN - 120
        ys = [240, 400, 560]
        g_top, g_bot = 162, 634

        def X(v):
            return lin(v, 0, 100, XL, XR)

        # series named directly under the first row's dots (no legend)
        a_names = prog(t, 1.9, 0.3)
        c.text(X(play[0]), ys[0] + 48, "Play policy alone", size=T_VALUE, color=SECONDARY, ha="center",
               alpha=prog(t, 0.45, 0.3), halo=True)
        c.text(X(dsp[0]), ys[0] + 48, "DSP", size=T_VALUE, color=INK, weight="semibold", ha="center",
               alpha=a_names, halo=True)

        for v in (0, 25, 50, 75, 100):
            c.vline(X(v), g_top, g_bot, color=AXIS if v == 0 else HAIRLINE)
            c.text(X(v), g_bot + 32, f"{v}", size=T_TICK, color=TICK, ha="center")
        c.text((XL + XR) / 2, g_bot + 86, "Success rate (%)", size=T_AXIS, color=SECONDARY, ha="center")

        for i, h in enumerate(D.THRESHOLDS):
            y = ys[i]
            c.text(label_r, y, h, size=T_LABEL, color=SECONDARY, ha="right")
            kp = ease_out(prog(t, 0.3 + 0.12 * i, 0.35))
            km = ease_out(prog(t, 1.0 + 0.15 * i, 0.9))
            xp = X(play[i])
            xd = xp + (X(dsp[i]) - xp) * km
            if km > 0:
                c.hline(xp, xd, y, color=S.SERIES["baseline2"], width=8, z=3)
            c.dot(xp, y, 13 * kp, SERIES["baseline"], ring=4, z=4)
            if km > 0:
                c.dot(xd, y, 14, SERIES["dsp"], ring=4, z=6)
            c.text(xp - 28, y, fmt1(play[i]), size=T_VALUE, color=SECONDARY, ha="right",
                   alpha=prog(t, 0.45 + 0.12 * i, 0.3), halo=True)
            a = prog(t, 1.0 + 0.15 * i + 0.75, 0.3)
            c.text(X(dsp[i]) + 28, y, fmt1(dsp[i]), size=T_STRONG, color=INK, weight="semibold", alpha=a,
                   halo=True)
            gain = dsp[i] - play[i]
            c.text((xp + X(dsp[i])) / 2, y - 42, f"+{gain:.1f} pp", size=T_VALUE, color=SECONDARY,
                   ha="center", alpha=a, halo=True)

    meta = {
        "columns": ["Controller"] + D.THRESHOLDS,
        "decimals": [None, 1, 1, 1],
        "unit": "Success rate (%) at each goal threshold",
        "rows": [[G["play"]["label"]] + play, [G["dsp"]["label"]] + dsp,
                 ["Gain (percentage points)"] + [round(d - p, 1) for p, d in zip(play, dsp)]],
        "notes": "Visual reorientation in simulation from RGB, 64 trials, 3,600-step horizon. The world model "
                 "plans in a learned 64-D latent. Not protocol-matched with the state-based results.",
    }
    return draw, 1600, 900, 3.8, meta


# ---------------------------------------------------------------- 6 scaling
def chart_scaling():
    Sc = D.SCALING
    hrs, mae = Sc["hours"], Sc["mae_deg"]
    XL, XR, YT, YB = 250, 1400, 150, 720
    H0, H1, V0, V1 = 0.45, 6.2, 26, 40

    def X(h):
        return logx(h, H0, H1, XL, XR)

    def Y(v):
        return lin(v, V0, V1, YB, YT)

    xs = [X(h) for h in hrs]
    ys = [Y(v) for v in mae]
    t0, t1 = 0.6, 2.6

    def draw(c, t):
        for v in (28, 32, 36, 40):
            c.hline(XL, XR, Y(v), color=HAIRLINE)
            c.text(XL - 18, Y(v), f"{v}°", size=T_TICK, color=TICK, ha="right")
        c.hline(XL, XR, YB, color=AXIS)
        c.text(XL - 18 - c.measure("40°", T_TICK)[0], YT - 62, "Mean rotation error, 50 steps ahead (°)",
               size=T_AXIS, color=SECONDARY, ha="left")
        for h, x in zip(hrs, xs):
            c.text(x, YB + 38, f"{h:.2f}", size=T_TICK, color=TICK, ha="center")
        c.text((XL + XR) / 2, YB + 92, "Hours of autonomous play on the robot (log scale)", size=T_AXIS,
               color=SECONDARY, ha="center")

        a = prog(t, 0.15, 0.35)
        yb = Y(Sc["persistence_deg"])
        c.hline(XL, XR, yb, color=S.SERIES["baseline"], width=3, alpha=a, z=2)
        c.text(XL + 6, yb - 26, f"Persistence baseline, predicting no motion: {Sc['persistence_deg']:.2f}°",
               size=T_VALUE, color=SECONDARY, alpha=a)

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
            c.polyline(px, py, SERIES["dsp"], width=5, z=3)
            for i in range(len(xs)):
                if xs[i] <= xe + 0.5:
                    reach = t0 + (t1 - t0) * ((xs[i] - xs[0]) / (xs[-1] - xs[0]))
                    c.dot(xs[i], ys[i], 10 * ease_out(prog(t, reach - 0.05, 0.25)), SERIES["dsp"], ring=4)
        a0 = prog(t, 0.75, 0.3)
        c.text(xs[0], ys[0] + 42, f"{mae[0]:.2f}°", size=T_VALUE, color=SECONDARY, ha="center", alpha=a0,
               halo=True)
        a1 = prog(t, t1, 0.3)
        c.text(xs[-1], ys[-1] - 42, f"{mae[-1]:.2f}°", size=T_STRONG, color=INK, weight="semibold",
               ha="center", alpha=a1)
        c.text(xs[-1], ys[-1] + 44, Sc["reduction_label"], size=T_VALUE, color=SECONDARY, ha="center",
               alpha=prog(t, t1 + 0.15, 0.3))

    meta = {
        "columns": ["Autonomous play (h)", "50-step rotation MAE (°)"],
        "rows": [[h, v] for h, v in zip(hrs, mae)],
        "decimals": [2, 2],
        "unit": "Hours of real-robot autonomous play, world-model rotation error in degrees",
        "notes": "Held-out evaluation and model fixed; only the amount of real-robot autonomous play changes. "
                 "Persistence baseline (predicting no motion): 38.60°. 34.96° to 28.40° is an 18.8% reduction.",
    }
    return draw, 1600, 900, 3.9, meta


# ---------------------------------------------------------------- 7 play_diversity
def chart_play_diversity():
    P = D.PLAY_DIVERSITY
    rows = P["rows"]
    kinds = ["dsp", "baseline"]
    measures = P["measures"]
    vals = [[m["values"][r] for m in measures] for r in rows]
    W, H = 1600, 460

    def draw(c, t):
        faceted_bars(c, t, rows, [m["header"] for m in measures], vals, kinds, y_header=92, y0=190,
                     pitch=104, axis_title=None, panel_gap=64,
                     value_room=c.measure("000.0", T_STRONG, "semibold")[0] + 24,
                     panel_vmax=[m["max"] for m in measures], panel_ticks=[m["ticks"] for m in measures],
                     strong=lambda r: r == 0)

    meta = {
        "columns": ["Play policy", "Rotation speed (°/s)", "SO(3) coverage (%)", "Transition coverage (%)",
                    "Held-out command error"],
        "rows": [[r] + [m["values"][r] for m in measures] + [P["command_error"][r]] for r in rows],
        "decimals": [None, 1, 1, 1, 3],
        "unit": "Measured on the closed-loop data each play policy collects",
        "notes": "Deterministic vs diffusion transformer play policy (paper table III). Speed and coverage come "
                 "from the closed-loop data each policy collects; held-out command error is nearly equal.",
    }
    return draw, W, H, 3.2, meta


# ---------------------------------------------------------------- 8 latency
def chart_latency():
    L = D.LATENCY
    W, H = 1600, 620
    T0, T1 = 0, 160
    lanes = ["Planner, one replan", "Camera and tracking", "Hand"]
    ys = [168, 286, 404]
    total = L["replan_total_ms"]
    frame = 1000.0 / L["camera_fps"]
    sweep0, sweep1 = 0.3, 3.0

    def draw(c, t):
        label_w = max(c.measure(s, T_LABEL, "semibold" if i == 0 else "regular")[0]
                      for i, s in enumerate(lanes))
        label_r = MARGIN + label_w
        XL, XR = label_r + 44, c.W - MARGIN - 150

        def X(ms):
            return lin(ms, T0, T1, XL, XR)

        g_top, g_bot = 104, 462
        for v in range(0, 161, 20):
            c.vline(X(v), g_top, g_bot, color=AXIS if v == 0 else HAIRLINE)
            c.text(X(v), g_bot + 32, f"{v}", size=T_TICK, color=TICK, ha="center")
        c.text((XL + XR) / 2, g_bot + 86, "Time (ms)", size=T_AXIS, color=SECONDARY, ha="center")
        for i, s in enumerate(lanes):
            c.text(label_r, ys[i], s, size=T_LABEL, color=INK if i == 0 else SECONDARY,
                   weight="semibold" if i == 0 else "regular", ha="right")

        ms_now = T1 * ease_in_out(prog(t, sweep0, sweep1 - sweep0)) if t >= sweep0 else 0.0

        # planner: stacked stages in time order, 4 px surface gaps, rounded data end on the last stage
        acc = 0.0
        n = len(L["planner"])
        for i, seg in enumerate(L["planner"]):
            s0, s1 = acc, acc + seg["ms"]
            acc = s1
            e = min(s1, ms_now)
            if e > s0:
                x0 = X(s0) + (GAP / 2 if i > 0 else 0)
                x1 = X(e) - (GAP / 2 if (i < n - 1 and e >= s1) else 0)
                c.hbar(x0, x1, ys[0], STAGE[seg["label"]], round_end=(i == n - 1), z=3)
            if ms_now >= s1 and seg["label"] != "Other":
                a = prog(ms_now, s1, 6)
                name_w = c.measure(seg["label"], T_VALUE, "medium")[0]
                if name_w + 28 < X(s1) - X(s0):
                    c.text((X(s0) + X(s1)) / 2, ys[0], seg["label"], size=T_VALUE, color="#ffffff",
                           weight="medium", ha="center", alpha=a)
                c.text((X(s0) + X(s1)) / 2, ys[0] + BAR / 2 + 24, f"{seg['ms']:.1f} ms", size=T_TICK,
                       color=TICK, ha="center", alpha=a, halo=True)
        if ms_now >= total:
            xe = X(total) + 18
            c.text(xe, ys[0] - 14, f"{total:.1f} ms", size=T_STRONG, color=INK, weight="semibold", halo=True)
            c.text(xe, ys[0] + 20, "per replan", size=T_TICK, color=SECONDARY, halo=True)

        # camera frames every 33.3 ms, tracking takes 19.4 ms of each
        k = 0
        while k * frame < T1:
            f0 = k * frame
            if ms_now >= f0:
                c.vline(X(f0), ys[1] - BAR / 2 - 8, ys[1] + BAR / 2 + 8, color=MUTED, width=2, z=4)
                e = min(f0 + L["tracking_ms"], ms_now, T1)
                c.hbar(X(f0) + 3, X(e), ys[1], SECONDARY, z=3)
                if k == 0 and ms_now >= L["tracking_ms"]:
                    c.text((X(0) + X(L["tracking_ms"])) / 2 + 2, ys[1], f"{L['tracking_ms']:.1f} ms",
                           size=T_TICK, color="#ffffff", weight="medium", ha="center")
            k += 1
        if ms_now >= T1 * 0.99:
            c.text(X(T1) + 18, ys[1], "30 fps", size=T_TICK, color=SECONDARY)

        # the hand keeps executing the current prefix while the planner runs
        if ms_now > 0:
            c.hbar(X(0), X(min(ms_now, T1)), ys[2], S.SERIES["baseline2"], round_end=False, z=3)
            if ms_now > 95:
                c.text(X(0) + 20, ys[2], "keeps executing the current action prefix", size=T_VALUE,
                       color=INK, alpha=prog(ms_now, 95, 25))

        # playhead
        a = 1 - prog(t, sweep1, 0.3)
        if t >= sweep0 and a > 0:
            c.vline(X(ms_now), g_top, g_bot, color=INK, width=3, alpha=a, z=7)

    meta = {
        "columns": ["Stage", "Median (ms)", "p95 (ms)"],
        "rows": [["Cube tracking, per camera frame", L["tracking_ms"], L["tracking_p95"]]]
                + [[s["table_label"], s["ms"], s["p95"]] for s in L["planner"][:3]]
                + [["Replan, end to end", total, L["replan_total_p95"]]],
        "decimals": [None, 1, 1],
        "unit": "Milliseconds on hardware, median and 95th percentile",
        "notes": "One RTX 5090 over a local network. 'Other' (5.5 ms) is the end-to-end median minus the three "
                 "stage medians. Planning overlaps execution, so the closed loop runs at 15 to 18 Hz.",
    }
    return draw, W, H, 4.2, meta


# ---------------------------------------------------------------- 9 wm_rot_error (frame-indexed, scrubbable)
def chart_wm_rot_error():
    E = D.WM_ROT_ERROR
    ts = [k / 15 for k in range(len(E["err_deg"]))]
    err = E["err_deg"]
    W, H = 1200, 640
    XL, XR, YT, YB = 112, 1150, 92, 532
    T_MAX, V_MAX = 2.07, 180

    def X(s):
        return lin(s, 0, T_MAX, XL, XR)

    def Y(v):
        return lin(v, 0, V_MAX, YB, YT)

    pts = [(X(s), Y(v)) for s, v in zip(ts, err)]

    def hits(box, k, r_dot):
        x0, y0, x1, y1 = box
        px, py = pts[k]
        nx, ny = min(max(px, x0), x1), min(max(py, y0), y1)
        if (nx - px) ** 2 + (ny - py) ** 2 < (r_dot + 6) ** 2:
            return True
        for i in range(k):
            (ax, ay), (bx, by) = pts[i], pts[i + 1]
            n = max(2, int(max(abs(bx - ax), abs(by - ay)) / 4))
            for j in range(n + 1):
                f = j / n
                qx, qy = ax + (bx - ax) * f, ay + (by - ay) * f
                if x0 - 6 <= qx <= x1 + 6 and y0 - 6 <= qy <= y1 + 6:
                    return True
        return False

    def draw(c, t):
        k = min(len(err) - 1, int(round(t * 15)))
        for v in (0, 45, 90, 135, 180):
            c.hline(XL, XR, Y(v), color=AXIS if v == 0 else HAIRLINE, width=2)
            c.text(XL - 26, Y(v), f"{v}", size=30, color=TICK, ha="right")
        c.text(40, 40, "Rotation error (°)", size=32, color=SECONDARY)
        for s in (0, 0.5, 1.0, 1.5, 2.0):
            c.text(X(s), YB + 38, f"{s:g}" if s == 0 else f"{s:.1f}", size=30, color=TICK, ha="center")
        c.text((XL + XR) / 2, YB + 86, "Time ahead (s)", size=32, color=SECONDARY, ha="center")

        if k > 0:
            c.polyline([p[0] for p in pts[:k + 1]], [p[1] for p in pts[:k + 1]], SERIES["dsp"], width=6, z=3)
        x, y = pts[k]
        r = 11
        c.dot(x, y, r, SERIES["dsp"], ring=5, z=5)

        label = f"{err[k]:.1f}°"
        w, h = c.measure(label, 34, "semibold")
        cands = [(x + 22, y, "left"), (x + 16, y - 42, "left"), (x + 16, y + 42, "left"), (x, y - 48, "center"),
                 (x, y + 48, "center"), (x - 16, y - 42, "right"), (x - 16, y + 42, "right")]
        best = None
        for lx, ly, ha in cands:
            bx0 = lx if ha == "left" else lx - w if ha == "right" else lx - w / 2
            box = (bx0, ly - h / 2, bx0 + w, ly + h / 2)
            inside = box[0] >= 8 and box[2] <= W - 8 and box[1] >= YT - 40 and box[3] <= YB - 6
            if inside and not hits(box, k, r):
                best = (lx, ly, ha)
                break
        if best is None:
            best = cands[3]
        c.text(best[0], best[1], label, size=34, color=INK, weight="semibold", ha=best[2], halo=True)

    meta = {
        "_toplevel": True,
        "fps": 15,
        "t_ahead_s": E["t_ahead_s"],
        "err_deg": err,
        "notes": "World-model rotation error vs prediction horizon on one held-out clip, read from the source "
                 "clip's frame titles. Frame k shows the curve up to k/15 s ahead.",
    }
    return draw, W, H, len(err) / 15, meta, {"fps": 15, "n_frames": len(err), "intra": True, "crf": 16}


CHARTS = {
    "sim_baselines": chart_sim_baselines,
    "sim_efficiency": chart_sim_efficiency,
    "real_vs_sim": chart_real_vs_sim,
    "pusht": chart_pusht,
    "rgb": chart_rgb,
    "scaling": chart_scaling,
    "play_diversity": chart_play_diversity,
    "latency": chart_latency,
    "wm_rot_error": chart_wm_rot_error,
}


def aspect(w, h):
    from math import gcd
    g = gcd(w, h)
    return f"{w // g}:{h // g}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chart", default="all", help="chart name or 'all'")
    ap.add_argument("--fonts", default=os.environ.get("DSP_FONT_DIR", ""),
                    help="directory holding IBMPlexSans-*.ttf (falls back to Helvetica)")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--mobile", action="store_true",
                    help="render the portrait phone variants (<name>_m.mp4/.jpg) instead of the desktop charts")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    fam = S.setup_fonts(args.fonts)
    print("font:", fam)

    if args.mobile:
        import mobile
        pool = mobile.CHARTS
    else:
        pool = CHARTS
    names = list(pool) if args.chart == "all" else [args.chart]
    manifest_path = os.path.join(args.out, "charts.json")
    manifest, extra_top = {}, {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as fh:
            doc = json.load(fh)
        manifest = {c["name"]: c for c in doc.get("charts", [])}
        extra_top = {k: v for k, v in doc.items() if k not in ("font", "charts")}
    for name in names:
        kw = {}
        if args.mobile:
            draw, w, h, dur = mobile.CHARTS[name]()
            base = f"{name}_m"
        else:
            res = CHARTS[name]()
            draw, w, h, dur, meta = res[:5]
            kw = res[5] if len(res) > 5 else {}
            base = name
        mp4 = os.path.join(args.out, f"{base}.mp4")
        jpg = os.path.join(args.out, f"{base}.jpg")
        frames = S.render(draw, w, h, dur, mp4, jpg, **kw)
        if not args.mobile and meta.get("_toplevel"):
            meta = {k: v for k, v in meta.items() if k != "_toplevel"}
            extra_top[name] = {"video": f"static/charts/{base}.mp4", "poster": f"static/charts/{base}.jpg",
                               "width": w, "height": h, "frames": frames, **meta}
            print(f"{base}: {w}x{h} {frames} frames {os.path.getsize(mp4) / 1024:.0f} KB")
            continue
        entry = {"width": w, "height": h, "aspect": aspect(w, h), "duration_s": dur, "frames": frames,
                 "video": f"static/charts/{base}.mp4", "poster": f"static/charts/{base}.jpg"}
        if args.mobile:
            if name not in manifest:
                raise SystemExit(f"render the desktop chart '{name}' first; the mobile entry is added to it")
            manifest[name]["mobile"] = entry
        else:
            keep = manifest.get(name, {}).get("mobile")
            manifest[name] = {"name": name, **entry, **meta}
            if keep:
                manifest[name]["mobile"] = keep
        size = os.path.getsize(mp4)
        print(f"{base}: {w}x{h} {dur}s {frames} frames {size / 1024:.0f} KB")
    ordered = [manifest[n] for n in CHARTS if n in manifest]
    with open(manifest_path, "w") as fh:
        json.dump({"font": fam, "charts": ordered, **extra_top}, fh, ensure_ascii=False, indent=2)
    print("wrote", manifest_path)


if __name__ == "__main__":
    main()
