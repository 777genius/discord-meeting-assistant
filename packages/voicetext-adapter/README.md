# Voicetext adapter

The adapter uploads Deepgram-compatible mono `pcm_s16le` audio through Voicetext
protocol v2. Uploads are ACK-driven and paced to `224000` bytes/second by
default, below the backend's `256000` bytes/second token-bucket rate.

## Memory boundary

This version does not transcode as a streaming pipeline. The complete bounded
Ogg track is read into memory, then ffmpeg's complete bounded PCM output is
materialized in memory before WebSocket frames are uploaded. The per-speaker and
total byte limits are therefore production safety boundaries, not estimates.
