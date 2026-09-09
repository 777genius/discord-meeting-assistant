# Get started

[Documentation](README.md) · [Botik](../README.md)

You will need:

- a server with persistent storage, Node.js `24.18.0`, Docker Compose `2.24.4+`
  and Docker Buildx `0.28.0+`;
- two user-owned Discord applications: one for recording and one for publishing;
- a Deepgram and/or ElevenLabs API key;
- a domain pointing to your server, with ports 80/443 available for HTTPS.

1. Clone this repository.
2. Follow the [Docker Compose setup](../infra/deployment/oss-meeting-topology.md)
   to configure credentials, build the services and check their health.
3. Install both bots in your Discord server with the documented permissions.
4. Run `/setup-voice-bot` as a server administrator and choose the voice channel
   to record and the text channel for results.
5. Join the selected voice channel. After the meeting ends, Botik posts the result.

Keep bot tokens and provider keys in the mounted secret files described in the
setup guide. Speech recognition uses your selected provider's API and billing.
