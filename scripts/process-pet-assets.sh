#!/usr/bin/env bash

set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
processor="$repository_root/scripts/process-pet-video.sh"
source_directory="$repository_root/assets/raw-videos"
asset_directory="$repository_root/assets/desktop-pet"
renderer_directory="$repository_root/apps/desktop/src/renderer/assets/pet"

assets=(
  "idle_摇尾巴.mp4|idle.webm|5.086"
  "思考.mp4|thinking.webm|5.086"
  "cat-working-enter-5s.mp4|working-enter.webm|5.062"
  "cat-working-loop-5s.mp4|working.webm|5.062"
  "cat-working-exit-5s.mp4|working-exit.webm|5.042"
  "提醒用户选择.mp4|waiting-permission.webm|5.086"
  "往左看.mp4|permission-reminder.webm|5.062"
  "cat-completed-gift-box-15s.mp4|completed.webm|15.070"
  "惊讶.mp4|failed.webm|5.086"
  "趴下休息.mp4|sleep-enter.webm|5.086"
  "cat-sleep-tail-smooth-2x.mp4|sleep.webm|4.125"
  "从趴下到起来坐下到默认姿态.mp4|wake.webm|10.101"
)

mkdir -p "$asset_directory" "$renderer_directory"

for asset in "${assets[@]}"; do
  IFS="|" read -r input output duration <<<"$asset"
  "$processor" \
    "$source_directory/$input" \
    "$asset_directory/$output" \
    "$duration"
  install -m 0644 "$asset_directory/$output" "$renderer_directory/$output"
done
