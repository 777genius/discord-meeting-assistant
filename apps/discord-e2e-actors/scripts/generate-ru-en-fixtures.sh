#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
fixture_dir="$package_dir/test/fixtures"
voice=${DISCORD_E2E_TTS_VOICE:-Milena}
rate=${DISCORD_E2E_TTS_RATE:-130}

case "$rate" in
  ''|*[!0-9]*)
    echo "DISCORD_E2E_TTS_RATE must be an integer from 100 to 250" >&2
    exit 1
    ;;
esac
if [ "$rate" -lt 100 ] || [ "$rate" -gt 250 ]; then
  echo "DISCORD_E2E_TTS_RATE must be an integer from 100 to 250" >&2
  exit 1
fi

command -v say >/dev/null 2>&1 || {
  echo "macOS say is required" >&2
  exit 1
}
command -v ffmpeg >/dev/null 2>&1 || {
  echo "ffmpeg is required" >&2
  exit 1
}
command -v ffprobe >/dev/null 2>&1 || {
  echo "ffprobe is required" >&2
  exit 1
}

for speaker in speaker-a speaker-b; do
  source_file="$fixture_dir/$speaker.ru-en.txt"
  aiff_file="$fixture_dir/$speaker.ru-en.aiff"
  output_file="$fixture_dir/$speaker.ru-en.ogg"

  say -v "$voice" -r "$rate" -f "$source_file" -o "$aiff_file"
  ffmpeg -hide_banner -loglevel error -y -i "$aiff_file" \
    -af "apad=pad_dur=0.75" -ar 48000 -ac 1 -c:a libopus -b:a 64k "$output_file"
  rm "$aiff_file"

  codec=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name \
    -of default=noprint_wrappers=1:nokey=1 "$output_file")
  duration=$(ffprobe -v error -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 "$output_file")
  hash=$(shasum -a 256 "$output_file" | awk '{print $1}')
  echo "$speaker codec=$codec duration=$duration sha256=$hash"
done

echo "Pin the printed audio hashes in retained E2E evidence before verification."
