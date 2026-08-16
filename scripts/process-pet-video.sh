#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 2 || $# -gt 4 ]]; then
  echo "Usage: $0 INPUT OUTPUT [DURATION] [KEY_COLOR]" >&2
  exit 2
fi

input=$1
output=$2
duration=${3:-5.0}
key_color=${4:-0x00EF04}
ffmpeg_bin=${FFMPEG_BIN:-ffmpeg}

mkdir -p "$(dirname "$output")"

"$ffmpeg_bin" -y -hide_banner -loglevel error \
  -i "$input" \
  -filter_complex "[0:v]trim=start=0:end=${duration},setpts=PTS-STARTPTS,format=rgba,colorkey=color=${key_color}:similarity=0.08:blend=0.025,despill=type=green:mix=0.2,scale=384:384:flags=lanczos,format=yuva420p[video]" \
  -map "[video]" \
  -an \
  -c:v libvpx-vp9 \
  -pix_fmt yuva420p \
  -b:v 0 \
  -crf 30 \
  -deadline good \
  -cpu-used 2 \
  -auto-alt-ref 0 \
  "$output"
