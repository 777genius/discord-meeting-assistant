import { z } from "zod";

const optionalAbsolutePath = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().startsWith("/").refine((value) => !value.includes("\0")).optional(),
);
const optionalHttpOrigin = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url().refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === "/" &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  }).optional(),
);

export const recordingPlaybackEnvironmentShape = {
  RECORDING_PLAYBACK_PUBLIC_BASE_URL: optionalHttpOrigin,
  RECORDING_PLAYBACK_SIGNING_SECRET_FILE: optionalAbsolutePath,
} as const;

interface RecordingPlaybackEnvironment {
  readonly NODE_ENV: "development" | "production" | "test";
  readonly RECORDING_PLAYBACK_PUBLIC_BASE_URL?: string | undefined;
  readonly RECORDING_PLAYBACK_SIGNING_SECRET_FILE?: string | undefined;
}

export function validateRecordingPlaybackEnvironment(
  environment: RecordingPlaybackEnvironment,
  context: z.RefinementCtx,
): void {
  const configuredParts = [
    environment.RECORDING_PLAYBACK_PUBLIC_BASE_URL,
    environment.RECORDING_PLAYBACK_SIGNING_SECRET_FILE,
  ].filter((value) => value !== undefined).length;
  if (configuredParts !== 0 && configuredParts !== 2) {
    context.addIssue({
      code: "custom",
      message: "recording playback public URL and signing secret must be configured together",
      path: ["RECORDING_PLAYBACK_PUBLIC_BASE_URL"],
    });
  }
  if (
    environment.NODE_ENV === "production" &&
    environment.RECORDING_PLAYBACK_PUBLIC_BASE_URL !== undefined &&
    new URL(environment.RECORDING_PLAYBACK_PUBLIC_BASE_URL).protocol !== "https:"
  ) {
    context.addIssue({
      code: "custom",
      message: "recording playback requires HTTPS in production",
      path: ["RECORDING_PLAYBACK_PUBLIC_BASE_URL"],
    });
  }
}

export async function loadRecordingPlaybackConfig(
  environment: RecordingPlaybackEnvironment,
  readSecret: (path: string) => Promise<string>,
): Promise<{
  readonly config?: { readonly publicBaseUrl: string };
  readonly signingSecret?: string;
}> {
  if (
    environment.RECORDING_PLAYBACK_PUBLIC_BASE_URL === undefined ||
    environment.RECORDING_PLAYBACK_SIGNING_SECRET_FILE === undefined
  ) {
    return {};
  }
  return {
    config: { publicBaseUrl: environment.RECORDING_PLAYBACK_PUBLIC_BASE_URL },
    signingSecret: await readSecret(
      environment.RECORDING_PLAYBACK_SIGNING_SECRET_FILE,
    ),
  };
}
