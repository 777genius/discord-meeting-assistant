import { loadActorConfig } from "./config.js";
import { connectDiscordVoiceActor } from "./discord-voice-actor.js";
import { MacOsKeychainSecretReader } from "./keychain.js";
import {
  closeActors,
  runActorScenario,
  type ReconnectableVoiceActor,
} from "./run-actor-scenario.js";

async function main(): Promise<void> {
  const config = loadActorConfig(process.env);
  const secretReader = new MacOsKeychainSecretReader(config.keychainService);
  const tokens = await Promise.all(
    config.speakers.map(async (speaker) => secretReader.read(speaker.account)),
  );
  process.stdout.write("Discord E2E credentials loaded from Keychain.\n");

  const actors: ReconnectableVoiceActor[] = [];
  try {
    for (const [index, speaker] of config.speakers.entries()) {
      const token = tokens[index];
      if (token === undefined) {
        throw new Error(`Missing Keychain credential for ${speaker.name}`);
      }
      process.stdout.write(`Discord E2E connecting ${speaker.name}.\n`);
      actors.push(await connectDiscordVoiceActor({
        name: speaker.name,
        token,
        guildId: config.guildId,
        voiceChannelId: config.voiceChannelId,
        fixturePath: speaker.fixturePath,
        readyTimeoutMilliseconds: config.readyTimeoutMilliseconds,
        playbackTimeoutMilliseconds: config.playbackTimeoutMilliseconds,
      }));
      process.stdout.write(`Discord E2E connected ${speaker.name}.\n`);
    }

    const [speakerA, speakerB] = actors;
    if (speakerA === undefined || speakerB === undefined) {
      throw new Error("Both Discord E2E actors are required");
    }
    process.stdout.write(`Discord E2E starting ${config.scenario} synthetic playback.\n`);
    await runActorScenario(speakerA, speakerB, {
      kind: config.scenario,
      speakerBDelayMilliseconds: config.speakerBDelayMilliseconds,
    });
    process.stdout.write("Discord E2E actors completed synthetic playback.\n");
  } finally {
    await closeActors(actors);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown actor harness failure";
  process.stderr.write(`Discord E2E actor harness failed: ${message}\n`);
  process.exitCode = 1;
});
