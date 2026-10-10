"""All numbers drawn in the chart videos. Single source of truth for scripts/charts.

Values come from the DSP paper (tables I-IV, figs. 5, 7, 10) and the slide deck.
Success rates are percentages. Thresholds: 0.4 rad = 22.9 deg, 0.6 rad = 34.4 deg,
0.8 rad = 45.8 deg.
"""

THRESHOLDS = ["0.4 rad (22.9°)", "0.6 rad (34.4°)", "0.8 rad (45.8°)"]

# Task B, simulated in-hand reorientation, 128 seeded trials (paper fig. 5a).
# Rows are drawn top to bottom in this order. "kind" picks the mark color.
SIM_BASELINES = [
    {"label": "DSP (ours)",              "kind": "dsp",      "sr": [72.7, 91.4, 96.1]},
    {"label": "Distilled policy (ours)", "kind": "distill",  "sr": [40.6, 72.7, 86.7]},
    {"label": "Hindsight BC",            "kind": "baseline", "sr": [25.8, 53.9, 71.9]},
    {"label": "Play policy",             "kind": "baseline", "sr": [15.6, 36.7, 54.7]},
    {"label": "Goal-conditioned BC",     "kind": "baseline", "sr": [21.9, 34.4, 50.0]},
    {"label": "PPO, same 701K frames",   "kind": "ppo",      "sr": [0.0, 0.0, 1.6]},
]

# Task B, interaction frames vs SR@0.6 rad (paper fig. 5b).
SIM_EFFICIENCY = {
    "points": [
        {"label": "Hindsight BC",      "kind": "baseline", "frames": 7.01e5, "sr06": 53.9},
        {"label": "PPO, same frames",  "kind": "ppo",      "frames": 7.01e5, "sr06": 0.0},
        {"label": "DSP",               "kind": "dsp",      "frames": 7.01e5, "sr06": 91.4},
        {"label": "PPO, 344M frames",  "kind": "ppo",      "frames": 3.44e8, "sr06": 86.7},
    ],
    "ppo_unlimited_sr06": 96.9,
    "ratio_label": "490× more frames",
}

# Task C, hardware reorientation (paper fig. 7). DSP in simulation is drawn as a reference tick.
REAL_VS_SIM = {
    "rows": [
        {"label": "DSP on hardware",          "kind": "dsp",       "sr": [68.6, 90.0, 97.1]},
        {"label": "Play policy",              "kind": "baseline",  "sr": [20.9, 38.3, 54.1]},
        {"label": "Cube random walk, SO(3)",  "kind": "baseline2", "sr": [6.3, 11.4, 17.5]},
        {"label": "Joint random walk",        "kind": "baseline2", "sr": [0.0, 0.0, 0.0]},
    ],
    "dsp_sim": [72.7, 91.4, 96.1],
}

# Task A, Push-T (paper table I). Coverage is listed for the table view only.
PUSHT = {
    "headers": ["Overlap ≥ 0.90", "Overlap ≥ 0.95"],
    "rows": [
        {"label": "DSP (ours)",          "kind": "dsp",      "sr": [98, 74], "coverage": 0.953},
        {"label": "Hindsight BC",        "kind": "baseline", "sr": [74, 36], "coverage": 0.764},
        {"label": "Behavior cloning",    "kind": "baseline", "sr": [64, 28], "coverage": 0.751},
        {"label": "Goal-conditioned BC", "kind": "baseline", "sr": [60, 34], "coverage": 0.733},
        {"label": "RL, matched data",    "kind": "ppo",      "sr": [0, 0],   "coverage": 0.155},
    ],
}

# Task D, visual reorientation from RGB, 64 trials, 3,600-step horizon.
RGB = {
    "play": {"label": "Play policy alone (RGB)", "sr": [34.4, 53.1, 76.6]},
    "dsp":  {"label": "DSP (RGB)",               "sr": [56.2, 78.1, 89.1]},
}

# Real-robot autonomous play hours vs 50-step rotation MAE in degrees (paper fig. 10).
SCALING = {
    "hours": [0.54, 1.03, 2.05, 3.30, 5.11],
    "mae_deg": [34.96, 33.13, 30.34, 29.10, 28.40],
    "persistence_deg": 38.60,
    "reduction_label": "−18.8%",
}

# Play policy design (paper table III).
PLAY_DIVERSITY = {
    "measures": [
        {"header": "Rotation speed (°/s)",    "max": 140, "ticks": [0, 70, 140], "unit": "",
         "values": {"Diffusion": 124.9, "Deterministic": 57.8}},
        {"header": "SO(3) coverage (%)",      "max": 100, "ticks": [0, 50, 100], "unit": "",
         "values": {"Diffusion": 98.8, "Deterministic": 87.6}},
        {"header": "Transition coverage (%)", "max": 100, "ticks": [0, 50, 100], "unit": "",
         "values": {"Diffusion": 84.2, "Deterministic": 55.4}},
    ],
    "rows": ["Diffusion", "Deterministic"],
    "command_error": {"Diffusion": 0.181, "Deterministic": 0.192},
}

# Hardware inference time per replan, medians in ms (paper table IV).
LATENCY = {
    "planner": [
        {"label": "Play policy", "table_label": "Play policy, 1,024 proposal chunks", "ms": 60.5, "p95": 64.3},
        {"label": "World model", "table_label": "World model, 1,024 × 25-step rollouts", "ms": 44.2, "p95": 50.3},
        {"label": "Scoring", "table_label": "MPC scoring and selection", "ms": 23.4, "p95": 26.4},
        {"label": "Other", "table_label": "Other (end to end minus the three stages)", "ms": 5.5, "p95": None},
    ],
    "replan_total_ms": 133.6,
    "replan_total_p95": 141.1,
    "tracking_ms": 19.4,
    "tracking_p95": 29.4,
    "camera_fps": 30,
}

# World-model rotation error vs prediction horizon for one held-out clip (deck slide 11).
# Read from the per-frame titles of the source clip ("world-model rotation error X deg at +Y s"),
# cross-checked against the plotted curve (agreement within 0.9 deg). Sample k is k/15 s ahead.
WM_ROT_ERROR = {
    "t_ahead_s": [round(k / 15, 2) for k in range(31)],
    "err_deg": [0.0, 1.9, 4.1, 4.9, 4.7, 4.2, 6.1, 2.3, 6.1, 9.4, 10.6, 13.0, 13.7, 14.0, 16.1, 14.0,
                18.0, 18.8, 9.9, 28.1, 23.8, 33.7, 38.2, 37.3, 38.7, 41.2, 39.8, 35.0, 33.3, 33.2, 28.5],
}
