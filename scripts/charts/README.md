# Chart videos

Each result chart on the page is a short MP4 (plays once when scrolled into view, then holds the last
frame) plus a JPG poster of that last frame. All numbers are in `data.py`.

Regenerate everything (needs Python with matplotlib + Pillow, and ffmpeg on PATH):

```bash
# IBM Plex Sans, OFL licensed: https://github.com/IBM/plex
mkdir -p /tmp/plex && for w in Regular Medium SemiBold Bold; do
  curl -sL -o /tmp/plex/IBMPlexSans-$w.ttf \
    https://raw.githubusercontent.com/IBM/plex/master/packages/plex-sans/fonts/complete/ttf/IBMPlexSans-$w.ttf
done
python3 scripts/charts/make_charts.py --fonts /tmp/plex            # all charts
python3 scripts/charts/make_charts.py --fonts /tmp/plex --chart rgb  # one chart
python3 scripts/charts/make_charts.py --fonts /tmp/plex --mobile     # phone variants, <name>_m.mp4/.jpg
```

The phone variants (`mobile.py`) are 1080 px wide portrait frames drawn for ~358 px on screen: same data,
colors and timing, small multiples stacked top to bottom, a few labels shortened. Render the desktop
charts first; `--mobile` adds a `mobile` entry (width, height, video, poster) to each chart in charts.json.

Output goes to `static/charts/<name>.mp4`, `static/charts/<name>.jpg` and `static/charts/charts.json`
(the exact rows drawn, used for the "Numbers" table under each chart).

| name | what it shows |
|---|---|
| sim_baselines | simulated reorientation, success at 0.4 / 0.6 / 0.8 rad for DSP and baselines |
| sim_efficiency | interaction frames vs success at 0.6 rad, DSP vs PPO (490×) |
| real_vs_sim | hardware success vs random walks and the play policy, with DSP's simulation result as a tick |
| pusht | Push-T success at overlap 0.90 and 0.95 |
| rgb | play policy alone vs DSP from RGB pixels |
| scaling | world-model error vs hours of autonomous play |
| play_diversity | deterministic vs diffusion play policy: speed and coverage |
| latency | one hardware replan on a time axis, with camera tracking and execution lanes |
| wm_rot_error | world-model rotation error vs time ahead; 31 all-intra frames at 15 fps for the page scrubber (frame k = sample k); values in the top-level `wm_rot_error` key of charts.json |

Frames are 1600 px wide and drawn for roughly 760 px on screen. Colors: DSP `#0072b2`, distilled policy
`#56a7e0`, PPO `#d55e00`, baselines gray; planner stages reuse the pipeline figure hues.
