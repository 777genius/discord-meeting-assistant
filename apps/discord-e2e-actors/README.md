# Discord E2E actors

This test-only CLI connects two official bot applications to one private guild
voice channel and plays synthetic Ogg Opus fixtures with a controlled overlap.
It never accepts bot tokens through environment variables or files.

Before a coordinated real-provider run, store both tokens in macOS Keychain
under service `discord-voice-bot-e2e`, accounts `speaker-a` and `speaker-b`.
Provide only the private test guild and voice channel IDs:

```sh
DISCORD_E2E_GUILD_ID=... \
DISCORD_E2E_VOICE_CHANNEL_ID=... \
pnpm --filter @discord-meeting/discord-e2e-actors start
```

Optional environment settings override the Keychain service/account names,
fixture paths, overlap delay, and readiness/playback timeouts. Do not run this
CLI against a public or user-owned guild.
