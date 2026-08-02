#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
fixture_dir="$package_dir/test/fixtures"
voice=${DISCORD_E2E_TTS_VOICE:-Milena}
rate=${DISCORD_E2E_TTS_RATE:-130}
english_voice=${DISCORD_E2E_TTS_ENGLISH_VOICE:-Daniel}
english_rate=${DISCORD_E2E_TTS_ENGLISH_RATE:-150}

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
case "$english_rate" in
  ''|*[!0-9]*)
    echo "DISCORD_E2E_TTS_ENGLISH_RATE must be an integer from 100 to 250" >&2
    exit 1
    ;;
esac
if [ "$english_rate" -lt 100 ] || [ "$english_rate" -gt 250 ]; then
  echo "DISCORD_E2E_TTS_ENGLISH_RATE must be an integer from 100 to 250" >&2
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
command -v perl >/dev/null 2>&1 || {
  echo "perl is required" >&2
  exit 1
}

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/discord-e2e-fixtures.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

for speaker in speaker-a speaker-b; do
  source_file="$fixture_dir/$speaker.ru-en.txt"
  aiff_file="$fixture_dir/$speaker.ru-en.aiff"
  output_file="$fixture_dir/$speaker.ru-en.ogg"

  if [ "$speaker" = "speaker-b" ]; then
    segmented_file="$work_dir/$speaker.segments"
    concat_file="$work_dir/$speaker.concat"
    perl -CSDA -0pe 's/((?i:Redis queue|idempotency key|Discord thread|Pipecat assistant))/\nEN|$1\n/g' \
      "$source_file" > "$segmented_file"
    segment_number=0
    while IFS= read -r segment || [ -n "$segment" ]; do
      [ -n "$segment" ] || continue
      segment_number=$((segment_number + 1))
      segment_voice=$voice
      segment_rate=$rate
      case "$segment" in
        EN\|*)
          segment=${segment#EN|}
          segment="$segment."
          segment_voice=$english_voice
          segment_rate=$english_rate
          ;;
      esac
      segment_aiff="$work_dir/$speaker-$segment_number.aiff"
      segment_wav="$work_dir/$speaker-$segment_number.wav"
      say -v "$segment_voice" -r "$segment_rate" -o "$segment_aiff" "$segment"
      ffmpeg -hide_banner -loglevel error -y -i "$segment_aiff" \
        -af "apad=pad_dur=0.2" -ar 48000 -ac 1 -c:a pcm_s16le "$segment_wav"
      printf "file '%s'\n" "$segment_wav" >> "$concat_file"
    done < "$segmented_file"
    ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$concat_file" \
      -c:a pcm_s16le "$aiff_file"
  else
    say -v "$voice" -r "$rate" -f "$source_file" -o "$aiff_file"
  fi
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
