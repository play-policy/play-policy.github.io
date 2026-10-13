"""Writes static/media.json from ffprobe of static/videos plus the hand-read HUD values.

usage: python3 -I manifest.py SITE_DIR HUD_READINGS_JSON
"""
import json
import os
import subprocess
import sys
from fractions import Fraction

from PIL import Image

site, hud_path = sys.argv[1:3]
vid_dir = os.path.join(site, "static", "videos")
hud = json.load(open(hud_path))

MPC = "Cropped 360x360 at (96,70) of 512x512 (same box for all four MPC clips), scaled to 480x480; first frame = <name>.jpg, last frame = <name>_last.jpg."
SKILL = "Emergent skill selected by play-guided MPC on hardware. Source tagged HLG/BT.2020 with SDR-looking 8-bit pixels; converted to BT.709 (matrix only) and cropped 1200x900 at (480,180) of 1920x1080."
NOTES = {
    "hero_human_play": "Goal-free human play: Manus glove teleoperation of the Sharpa hand (deck slides 2 and 7).",
    "auto_play": "Autonomous play: the learned play policy running on the robot by itself (deck slide 9); first 8 s removed.",
    "motiv_teleop": "Task-specific teleoperation rig used to collect behavior-cloning demos (deck slide 4).",
    "motiv_rl_sim": "Massively parallel RL simulation (deck slide 4; source file name says boomerang, 5x speed). First 12 s, black top band cropped.",
    "pusht_play": "Push-T: autonomous play data (state-based sim). Gray frame border cropped (492x492 at 10,10 of 512x512).",
    "pusht_mpc": "Push-T: play-guided MPC pushes the T onto the green target. Gray frame border cropped (492x492 at 10,10 of 512x512).",
    "mpc_context": "MPC explainer (deck slide 13): current state in sim. " + MPC,
    "mpc_proposal_best": "MPC explainer: predicted outcome of the middle proposal, marked BEST on deck slide 13. " + MPC,
    "mpc_proposal_b": "MPC explainer: predicted outcome of the bottom proposal on deck slide 13. " + MPC,
    "mpc_proposal_c": "MPC explainer: predicted outcome of the top proposal on deck slide 13. " + MPC,
    "sim_reorient": "Simulated in-hand reorientation with goal/error/SO(3) HUD (deck slide 18). Cropped 1440x1080 at (470,0) of 1920x1080 (empty left third removed, HUD kept whole), scaled to 1200x900.",
    "wm_camera": "World-model figure (deck slide 11): camera view over the 2 s prediction window. All-intra for scrubbing.",
    "wm_pose_overlay": "World-model figure: 3D cube, ground truth (green) vs prediction (blue). Title and boxed legend cropped away (600x582 at 80,118 of 700x700, padded white to 600x600). All-intra.",
    "wm_rot_error": "World-model figure: rotation error (deg) vs time ahead, 0 to 2 s. All-intra.",
    "wm_state_pred": "State world model (deck slide 20): left = ground truth (tracker), right = world-model prediction with the ground truth as a thin grey ghost. Titles and legends cropped away: 580x580 at (82,112) and (799,112) of 1400x700, side by side. All-intra.",
    "wm_rgb_pred": "Pixel world model (deck slide 20, paper Fig. 8): two unlabeled panels, left ground truth and right prediction (inferred from Fig. 8). Upscaled 2x. All-intra.",
    "skill_yaw_tip": "Yaw rotation with the thumb tip. " + SKILL,
    "skill_yaw_root": "Yaw rotation with the thumb root. " + SKILL,
    "skill_edge_flip": "Edge flip. " + SKILL,
    "skill_corner_flip": "Corner flip. " + SKILL,
    "skill_fine_adjust": "Fine adjustment. " + SKILL,
    "skill_composite": "Composite actions. " + SKILL,
}
REAL = "Hardware reorientation run with HUD: goal and current cube, distance to goal (deg) vs time (s), SO(3) trajectory."


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames:format=duration,size",
         "-of", "json", path],
        check=True, capture_output=True, text=True).stdout
    j = json.loads(out)
    s, f = j["streams"][0], j["format"]
    return {
        "width": s["width"], "height": s["height"],
        "duration_s": round(float(f["duration"]), 3),
        "fps": round(float(Fraction(s["r_frame_rate"])), 3),
        "frames": int(s["nb_read_frames"]),
        "bytes": int(f["size"]),
    }


videos = []
for fn in sorted(os.listdir(vid_dir)):
    if not fn.endswith(".mp4"):
        continue
    name = fn[:-4]
    entry = {"name": name, "file": f"static/videos/{fn}"}
    entry.update(probe(os.path.join(vid_dir, fn)))
    entry["poster"] = f"static/posters/{name}.jpg"
    if os.path.exists(os.path.join(site, "static", "posters", f"{name}_last.jpg")):
        entry["poster_last"] = f"static/posters/{name}_last.jpg"
    if name in hud:
        h = hud[name]
        entry["thumb"] = f"static/posters/thumbs/{name}.jpg"
        entry["note"] = f"{REAL} {h['run_id']}. {h['speed_note']}"
        entry["run_id"] = h["run_id"]
        entry["start_deg"] = h["start_deg"]
        entry["end_deg"] = h["end_deg"]
        entry["hud_end_s"] = h["hud_end_s"]
    else:
        entry["note"] = NOTES.get(name, "")
    videos.append(entry)

images = []
img_dir = os.path.join(site, "static", "images")
for fn in sorted(os.listdir(img_dir)):
    if fn.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
        with Image.open(os.path.join(img_dir, fn)) as im:
            images.append({"file": f"static/images/{fn}", "width": im.width, "height": im.height,
                           "bytes": os.path.getsize(os.path.join(img_dir, fn))})

manifest = {
    "videos": videos,
    "images": images,
    "total_video_bytes": sum(v["bytes"] for v in videos),
}
with open(os.path.join(site, "static", "media.json"), "w") as fh:
    json.dump(manifest, fh, indent=1)
print(f"media.json: {len(videos)} videos, {manifest['total_video_bytes'] / 1e6:.1f} MB")
