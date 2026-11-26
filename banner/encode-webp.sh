#!/bin/sh
# Animated WebP for the README: 1200 x 450, 24 fps (192 frames, 8 s), lossy quality 63, loops forever.
# Needs node, ffmpeg and img2webp (libwebp tools). Run from this directory after `npm install`.
# Frames are rendered at phase i/192, so the last frame leads straight into frame 0.
set -eu
OUT=output/storm-cyclone.webp
rm -rf output/frames24 output/frames1200
node render.cjs --frames output/frames24 --fps 24
mkdir -p output/frames1200
ffmpeg -y -hide_banner -loglevel error -framerate 24 -i output/frames24/f%04d.png \
	-vf scale=1200:450:flags=lanczos -start_number 0 output/frames1200/f%04d.png
# 24 fps is 41.67 ms per frame: durations alternate 42/42/41 ms so the loop is exactly 8000 ms.
args=""
i=0
while [ $i -lt 192 ]; do
	a=$(( ( (i+1)*16000/192 + 1 ) / 2 )); b=$(( ( i*16000/192 + 1 ) / 2 ))
	args="$args -d $((a-b)) output/frames1200/f$(printf %04d $i).png"
	i=$((i+1))
done
img2webp -loop 0 -lossy -q 63 -m 6 $args -o "$OUT"
ls -l "$OUT"
