#!/bin/bash
# render-video.sh - Add overlays to gatekeeper demo
#
# Uses ImageMagick for title cards (ffmpeg drawtext not available)
#
# Usage: npm run gatekeeper:render
# Input: gatekeeper-demo.mp4
# Output: gatekeeper-final.mp4

set -e

INPUT="gatekeeper-demo.mp4"
OUTPUT="gatekeeper-final.mp4"
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Video dimensions
WIDTH=1200
HEIGHT=700

echo "Creating title cards with ImageMagick..."

# Intro card
magick -size ${WIDTH}x${HEIGHT} xc:black \
  -font Helvetica -fill white \
  -gravity center \
  -pointsize 48 -annotate +0-30 "We gave an AI agent one harmless task." \
  -pointsize 36 -annotate +0+40 "This is what happened." \
  "${TEMP_DIR}/intro.png"

# Outro card 1
magick -size ${WIDTH}x${HEIGHT} xc:black \
  -font Helvetica -fill white \
  -gravity center \
  -pointsize 48 -annotate +0-20 "Nothing about the agent changed." \
  -pointsize 36 -annotate +0+40 "Only the trust boundary did." \
  "${TEMP_DIR}/outro1.png"

# Outro card 2
magick -size ${WIDTH}x${HEIGHT} xc:black \
  -font Helvetica -fill white \
  -gravity center \
  -pointsize 36 -annotate +0-30 "AI agents fail because we trust them too much." \
  -pointsize 48 -annotate +0+40 "Agents need governance, not smarter prompts." \
  "${TEMP_DIR}/outro2.png"

# Footer card
magick -size ${WIDTH}x${HEIGHT} xc:black \
  -font Helvetica -fill white \
  -gravity center \
  -pointsize 32 -annotate +0+0 "Runestone Gatekeeper · Open Source" \
  "${TEMP_DIR}/footer.png"

echo "Converting images to video segments..."

# Intro (3 seconds)
ffmpeg -y -loop 1 -i "${TEMP_DIR}/intro.png" -c:v libx264 -t 3 -pix_fmt yuv420p -r 25 "${TEMP_DIR}/intro.mp4"

# Outro 1 (3 seconds)
ffmpeg -y -loop 1 -i "${TEMP_DIR}/outro1.png" -c:v libx264 -t 3 -pix_fmt yuv420p -r 25 "${TEMP_DIR}/outro1.mp4"

# Outro 2 (4 seconds)
ffmpeg -y -loop 1 -i "${TEMP_DIR}/outro2.png" -c:v libx264 -t 4 -pix_fmt yuv420p -r 25 "${TEMP_DIR}/outro2.mp4"

# Footer (2 seconds)
ffmpeg -y -loop 1 -i "${TEMP_DIR}/footer.png" -c:v libx264 -t 2 -pix_fmt yuv420p -r 25 "${TEMP_DIR}/footer.mp4"

echo "Re-encoding main video for concat compatibility..."
ffmpeg -y -i "$INPUT" -c:v libx264 -pix_fmt yuv420p -r 25 "${TEMP_DIR}/main.mp4"

echo "Concatenating all segments..."
cat > "${TEMP_DIR}/filelist.txt" << EOF
file 'intro.mp4'
file 'main.mp4'
file 'outro1.mp4'
file 'outro2.mp4'
file 'footer.mp4'
EOF

ffmpeg -y -f concat -safe 0 -i "${TEMP_DIR}/filelist.txt" \
  -c:v libx264 -pix_fmt yuv420p "$OUTPUT"

# Get duration
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUTPUT")

echo ""
echo "✓ Created $OUTPUT"
echo "  Duration: ${DURATION}s"
echo "  Size: $(du -h "$OUTPUT" | cut -f1)"
