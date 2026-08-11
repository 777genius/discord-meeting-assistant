import { isAbsolute } from "node:path";

import { z } from "zod";

const absolutePath = z.string().refine(isAbsolute);
const correlationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);

export const collectorEnvironmentSchema = z.object({
  DISCORD_E2E_ACTOR_RUN_INPUT: absolutePath,
  DISCORD_E2E_BOTIK_SPEAKER_ID: correlationId.optional(),
  DISCORD_E2E_CONVERSATION_VOICE_INPUTS: z.string().transform((value, context) => {
    try {
      return z.array(absolutePath).min(5).parse(JSON.parse(value) as unknown);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Expected a JSON array of at least five absolute voice evidence paths",
      });
      return z.NEVER;
    }
  }).optional(),
  DISCORD_E2E_EVIDENCE_OUTPUT: absolutePath,
  DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION: z.string().min(1),
  DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION: z.string().min(1),
  DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION: z.string().min(1).optional(),
  DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION: z.string().min(1),
  DISCORD_E2E_FIXTURE_MANIFEST: z.string().min(1).default("test/fixtures/manifest.v1.json"),
  DISCORD_E2E_KEYCHAIN_SERVICE: z.string().min(1).default("discord-voice-bot-e2e"),
  DISCORD_E2E_RECORDING_ID: correlationId,
  DISCORD_E2E_REMOTE_CRAIG_PROJECT: z.string().min(1).default("craig-meeting-e2e"),
  DISCORD_E2E_REMOTE_CRAIG_SERVICE: z.string().min(1).default("bot"),
  DISCORD_E2E_REMOTE_COMPOSE_FILE: absolutePath.default(
    "/mnt/volume_ams3_1784742570542/discord-meeting-assistant/source/infra/deployment/compose.yaml",
  ),
  DISCORD_E2E_REMOTE_ENV_FILE: absolutePath.default(
    "/mnt/volume_ams3_1784742570542/discord-meeting-assistant/source.env",
  ),
  DISCORD_E2E_REMOTE_HOST: z.string().min(1).default("codex-workers-eu-01"),
  DISCORD_E2E_REMOTE_PROJECT: z.string().min(1).default("discord-meeting-assistant"),
  DISCORD_E2E_REMOTE_SOURCE_ROOT: absolutePath.default(
    "/mnt/volume_ams3_1784742570542/discord-meeting-assistant/source",
  ),
  DISCORD_E2E_RUN_ID: correlationId,
  DISCORD_E2E_SECRET_DIRECTORY: absolutePath.optional(),
  DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT: absolutePath.optional(),
  DISCORD_E2E_SUT_ACCOUNT: z.string().min(1).default("sut"),
}).superRefine((value, context) => {
  const conversationInputs = [
    value.DISCORD_E2E_BOTIK_SPEAKER_ID,
    value.DISCORD_E2E_CONVERSATION_VOICE_INPUTS,
    value.DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT,
  ];
  if (conversationInputs.some((input) => input !== undefined) &&
    conversationInputs.some((input) => input === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Botik speaker ID, conversation voice, and supplemental playback must be supplied together",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_INPUTS"],
    });
  }
});
