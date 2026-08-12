import { z } from "zod";

export const maximumTracks = 11;

export const playbackManifestSchema = z.object({
  recordingId: z.string().trim().min(1).max(256),
  schemaVersion: z.literal(1),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{32}$/u),
  status: z.enum(["processing", "ready", "unavailable"]),
  tracks: z.array(z.object({
    timelineOffsetMs: z.number().int().nonnegative(),
    url: z.string().min(1).max(2_048),
  }).strict()).max(maximumTracks),
}).strict();

export type PlaybackManifest = z.infer<typeof playbackManifestSchema>;

export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function mapConcurrently<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: values.length });
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) {
        return;
      }
      results[index] = await map(values[index]!, index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => worker(),
  ));
  return results;
}
