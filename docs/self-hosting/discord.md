# Discord applications and first meeting

[Self-hosting](README.md) · [Installation](installation.md)

## 1. Create two applications

In the Discord Developer Portal, create two official applications you own:

| Application | Responsibility | Deployment value |
| --- | --- | --- |
| Publication bot | Commands, captions and final results | `DISCORD_PUBLICATION_APPLICATION_ID` |
| Craig recording bot | Joining voice and retaining recordings | `DISCORD_CRAIG_APPLICATION_ID` |

Copy each application's ID from its application settings. Create/reset each
bot token as needed and store it in its [designated secret file](storage-and-secrets.md).
An application ID, client secret and bot token are different values. Do not use
a personal Discord account token or the public Craig bot. The two IDs and tokens
must differ. You may name the publication bot Botik; the name is not the ID.

Enable Developer Mode in the Discord client to copy channel IDs. Create a
private voice channel for initial testing and a private text channel for results.
Set the text channel's ID as `DISCORD_RESULTS_CHANNEL_ID` in the deployment file.
Leave the legacy guild/voice ID settings empty for new installations.

Message Content intent is required for optional Local Final Reply, not merely
for the base recording-and-publication scenario. See [Meeting memory](meeting-memory.md).

## 2. Start the stack and invite the bots

Complete [Installation](installation.md) through healthy services. Read Platform's
startup log for its generated Discord install URL:

```sh
botik_compose logs --tail 200 meeting-platform
```

The `botik_compose` helper is defined in the installation guide. Open the logged
publication install URL and select your test guild. It requests the application's
configured permissions. Invite Craig separately using its own application ID:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_CRAIG_APPLICATION_ID&scope=bot%20applications.commands&permissions=68176896
```

Check channel overrides as well as guild roles: Craig must see and connect to
the voice channel, and the publication bot must see the results channel and be
able to send messages, embeds and attachments. Use the generated permissions;
do not grant Administrator to work around a denied channel override.

## 3. Select the channels

As a member with **Manage Server**, run `/setup-voice-bot` in your guild. Select
the voice channel to record and the text channel for results. Check the command's
confirmation before inviting people into a recording session.

If the command does not appear, verify the publication application was installed
with `applications.commands`, is online, and is in the correct guild. If it
rejects configuration, check your Manage Server permission and bot access to
both selected channels.

## 4. Verify the first meeting

Use the private test guild and synthetic audio. Do not use customer recordings,
public channels or self-bots for qualification. The base recorder starts when
people join the configured voice channel. A bot-only synthetic actor campaign
needs the separate [test procedure](../../infra/deployment/oss-discord-stt-campaign.md);
ordinary bot presence alone is not evidence that auto-recording should start.

1. Join the configured test channel and confirm Craig joins/records.
2. Play a short synthetic spoken fixture with a few recognizable phrases.
3. Leave the channel so the meeting can finish; allow transcription and publishing
   to complete. There is no universal completion-time promise.
4. Confirm the results channel receives the final transcript attachment with
   speaker identity, timestamps and the expected phrases.
5. Confirm originals remain under the deployment's `data/craig/recordings`.

With base settings, expect a turn-count outline, not generated decisions or
an AI overview. For the corresponding richer output, follow [AI summaries](ai-summaries.md).
Inform real participants that the configured channel is recorded and which
external providers process its audio before moving beyond the test setup.

## Publication styles

`DISCORD_PUBLICATION_MODE=message` posts into the chosen text channel.
`thread` is an explicit alternative. `DISCORD_FINAL_PUBLICATION_MODE=separate-message`
keeps a live draft and posts a separate final result; `replace-live` reuses the
live message. Keep the defaults initially. Local Final Reply requires message
mode. Redeploy after changing these settings.
