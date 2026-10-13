#!/usr/bin/env bash
# Builds every web video, poster, thumbnail and still used by the DSP site.
#
# usage: bash scripts/media/build_media.sh SRC_MEDIA_DIR PAPER_IMGS_DIR SITE_DIR
#   SRC_MEDIA_DIR   ppt/media/ folder of the unzipped DSP deck (mediaN.mp4, imageN.png)
#   PAPER_IMGS_DIR  images extracted from the paper PDF (p6_x121.png, p7_x139.png)
#   SITE_DIR        site root; writes static/videos, static/posters, static/images, static/media.json
# The three paths can also come from the env vars SRC, PAPER and SITE.
# Needs ffmpeg/ffprobe (libx264) and python3 with Pillow.
set -euo pipefail

SRC="${1:-${SRC:?pass SRC_MEDIA_DIR}}"
PAPER="${2:-${PAPER:?pass PAPER_IMGS_DIR}}"
SITE="${3:-${SITE:?pass SITE_DIR}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FF="${FFMPEG:-ffmpeg}"

VID="$SITE/static/videos"
POS="$SITE/static/posters"
mkdir -p "$VID" "$POS/thumbs" "$SITE/static/images"

TAGS=(-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv)
OUT=(-an -sn -dn -map_metadata -1 -movflags +faststart -tag:v avc1 -pix_fmt yuv420p
     -c:v libx264 -profile:v high -preset slow)
# Every source is treated as BT.709 SDR. The skill clips are tagged HLG/BT.2020 but carry
# 8-bit, SDR-looking pixels, so they only get a BT.2020 -> BT.709 matrix conversion (no tone mapping).
AS709="setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"
FROM2020="colorspace=space=bt709:trc=bt709:primaries=bt709:range=tv:ispace=bt2020ncl:itrc=bt709:iprimaries=bt709:irange=tv"

# footage NAME SRCFILE CRF VF [input args...]   camera footage: 30 fps, <= 1280 wide
footage() {
  local name=$1 src=$2 crf=$3 vf=$4; shift 4
  "$FF" -v error -y "$@" -i "$SRC/$src" -map 0:v:0 -vf "$vf,fps=30,format=yuv420p" \
    "${OUT[@]}" -crf "$crf" "${TAGS[@]}" "$VID/$name.mp4"
  echo "  $name"
}
# synthetic NAME SRCFILE CRF VF   rendered clips on flat backgrounds (low CRF against banding)
synthetic() {
  local name=$1 src=$2 crf=$3 vf=$4
  "$FF" -v error -y -i "$SRC/$src" -map 0:v:0 -vf "$vf,format=yuv420p" \
    "${OUT[@]}" -crf "$crf" -tune animation "${TAGS[@]}" "$VID/$name.mp4"
  echo "  $name"
}
# scrub NAME SRCFILE CRF VF   all-intra, native fps, every source frame kept (frame-accurate seeking)
scrub() {
  local name=$1 src=$2 crf=$3 vf=$4
  "$FF" -v error -y -i "$SRC/$src" -map 0:v:0 -vf "$vf,format=yuv420p" -fps_mode passthrough \
    "${OUT[@]}" -crf "$crf" -g 1 -keyint_min 1 -bf 0 -sc_threshold 0 \
    -x264-params keyint=1:min-keyint=1:scenecut=0 "${TAGS[@]}" "$VID/$name.mp4"
  echo "  $name"
}

FIT="$AS709,scale='min(1280,iw)':-2:flags=lanczos"

echo "videos:"
footage hero_human_play media1.mov 27 "$FIT"
footage auto_play       media7.MOV 27 "$FIT" -ss 8
footage motiv_teleop    media6.mp4 27 "$FIT"
# 588x588 source with a black band on top; keep the 588x440 picture, first 12 s.
footage motiv_rl_sim    media5.mp4 25 "$AS709,crop=588:440:0:148" -t 12

i=1
for m in 3 15 16 17 18 19 20 21; do
  footage "$(printf 'real_%02d' $i)" "media$m.mp4" 27 "$FIT"
  i=$((i + 1))
done

# Same crop for all six skill clips (hand + cube region of the 1920x1080 frame), 4:3, 720 wide.
SKILL_CROP="crop=1200:900:480:180"
SKILL_VF="$FROM2020,$SKILL_CROP,scale=720:540:flags=lanczos"
footage skill_yaw_tip     media22.mp4 27 "$SKILL_VF"
footage skill_composite   media23.mp4 27 "$SKILL_VF"
footage skill_yaw_root    media24.mp4 27 "$SKILL_VF"
footage skill_corner_flip media25.mp4 27 "$SKILL_VF"
footage skill_edge_flip   media26.mp4 27 "$SKILL_VF"
footage skill_fine_adjust media27.mp4 27 "$SKILL_VF"

# Push-T: drop the 5 px gray frame drawn 3..8 px inside the 512x512 canvas (symmetric, stays square).
PUSHT_CROP="crop=492:492:10:10"
synthetic pusht_play        media2.mp4  20 "$AS709,$PUSHT_CROP"
synthetic pusht_mpc         media4.mp4  20 "$AS709,$PUSHT_CROP"
# MPC explainer: one square that holds hand + cube in every frame of all four clips
# (union of content measured over all frames: x 116..436, y 82..419), upscaled to 480.
MPC_CROP="crop=360:360:96:70,scale=480:480:flags=lanczos"
synthetic mpc_context       media11.mp4 21 "$AS709,$MPC_CROP,fps=30"
synthetic mpc_proposal_best media12.mp4 21 "$AS709,$MPC_CROP,fps=30"
synthetic mpc_proposal_b    media13.mp4 21 "$AS709,$MPC_CROP,fps=30"
synthetic mpc_proposal_c    media14.mp4 21 "$AS709,$MPC_CROP,fps=30"
# Sim run: the left third of the frame is empty. 4:3 box with the hand (x 625..1431) and the full HUD (x 1436..1901).
synthetic sim_reorient      media28.mp4 21 "$AS709,crop=1440:1080:470:0,scale=1200:900:flags=lanczos"

scrub wm_camera       media8.mp4  24 "$AS709"
# Drop the in-plot title and the boxed legend (top 118 px); white padding keeps it square at 600.
scrub wm_pose_overlay media9.mp4  22 "$AS709,crop=600:582:80:118,pad=600:600:0:9:color=white"
scrub wm_rot_error    media10.mp4 22 "$AS709"
# Two 3D panels without the figure title, panel titles and legends. The right plot sits 17 px further
# right than the left one, so each half gets its own 580x580 box; left = ground truth, right = prediction.
scrub wm_state_pred   media29.mp4 22 "$AS709,split[a][b];[a]crop=580:580:82:112[l];[b]crop=580:580:799:112[r];[l][r]hstack=inputs=2"
scrub wm_rgb_pred     media30.mp4 22 "$AS709,scale=iw*2:ih*2:flags=lanczos"

# Posters come from the encoded files, so they match the crop and scale on the page.
echo "posters:"
POSTER_TMP="$(mktemp -d)"
trap 'rm -rf "$POSTER_TMP"' EXIT
poster() {  # poster NAME SECONDS   ("0" = exact first frame)
  local name=$1 t=$2
  if [ "$t" = "0" ]; then
    "$FF" -v error -y -i "$VID/$name.mp4" -frames:v 1 "$POSTER_TMP/$name.png"
  else
    "$FF" -v error -y -ss "$t" -i "$VID/$name.mp4" -frames:v 1 "$POSTER_TMP/$name.png"
  fi
}
poster hero_human_play 2
poster auto_play 1
poster motiv_teleop 2
poster motiv_rl_sim 1
poster real_01 1; poster real_02 10; poster real_03 1; poster real_04 1
poster real_05 1; poster real_06 2;  poster real_07 1; poster real_08 1
for s in yaw_tip composite yaw_root corner_flip edge_flip fine_adjust; do poster "skill_$s" 0.3; done
poster sim_reorient 0.5
for n in pusht_play pusht_mpc mpc_context mpc_proposal_best mpc_proposal_b mpc_proposal_c \
         wm_camera wm_pose_overlay wm_rot_error wm_state_pred wm_rgb_pred; do
  poster "$n" 0
done
# The MPC explainer also needs each clip's final frame (<name>_last.jpg); -update keeps the last decoded frame.
for n in mpc_context mpc_proposal_best mpc_proposal_b mpc_proposal_c; do
  "$FF" -v error -y -sseof -0.25 -i "$VID/$n.mp4" -update 1 "$POSTER_TMP/${n}_last.png"
done
# Frames for the social card: human play on the left, the end of real_01 (cube at the goal) on the right.
"$FF" -v error -y -ss 2 -i "$VID/hero_human_play.mp4" -frames:v 1 "$POSTER_TMP/og_left.png"
"$FF" -v error -y -ss 45 -i "$VID/real_01.mp4" -frames:v 1 "$POSTER_TMP/og_right.png"

python3 -I "$HERE/images.py" "$POSTER_TMP" "$SRC" "$PAPER" "$SITE"
# Push-T planning panels (paper Fig. 9) as short build-up clips; needs the images from images.py.
FFMPEG="$FF" python3 -I "$HERE/pusht_build.py" "$SITE"
python3 -I "$HERE/manifest.py" "$SITE" "$HERE/hud_readings.json"
echo "done"
