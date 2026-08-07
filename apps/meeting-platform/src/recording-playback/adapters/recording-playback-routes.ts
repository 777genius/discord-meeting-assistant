import { Readable } from "node:stream";

import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import {
  type GetRecordingPlayback,
  RecordingPlaybackNotReadyError,
  RecordingPlaybackTrackNotFoundError,
  type RecordingPlaybackByteRange,
} from "../application/recording-playback.js";
import type {
  RecordingPlaybackAccess,
  VerifiedRecordingPlaybackAccess,
} from "./hmac-recording-playback-access.js";
import {
  recordingPlaybackClientScript,
  recordingPlaybackPageHtml,
  recordingPlaybackStyle,
} from "./recording-playback-page.js";
import {
  RecordingPlaybackAudioUnavailableError,
  RecordingPlaybackRangeNotSatisfiableError,
} from "./s3-recording-playback-audio-reader.js";

const accessCookieName = "recording_playback_access";
const sessionCookieMaximumAgeSeconds = 7 * 24 * 60 * 60;

interface RecordingPlaybackRoutesOptions {
  readonly access: RecordingPlaybackAccess;
  readonly playback: GetRecordingPlayback;
  readonly secureCookies: boolean;
}

export function createRecordingPlaybackRoutesPlugin(
  options: RecordingPlaybackRoutesOptions,
): FastifyPluginCallback {
  return (app, _pluginOptions, done) => {
    app.get("/recordings/playback", async (_request, reply) => {
      setPageSecurityHeaders(reply);
      return reply.type("text/html; charset=utf-8").send(recordingPlaybackPageHtml);
    });
    app.get("/recordings/player.css", async (_request, reply) => {
      setStaticAssetHeaders(reply);
      return reply.type("text/css; charset=utf-8").send(recordingPlaybackStyle);
    });
    app.get("/recordings/player.js", async (_request, reply) => {
      setStaticAssetHeaders(reply);
      return reply
        .type("text/javascript; charset=utf-8")
        .send(recordingPlaybackClientScript);
    });
    app.post("/recordings/session", async (request, reply) => {
      const verified = verifyBearer(request, options.access);
      if (verified === null) {
        return sendNotFound(reply);
      }
      const manifest = await options.playback.manifest(verified.meetingId);
      setPrivateHeaders(reply);
      reply.header(
        "set-cookie",
        createSessionCookie(verified, options.secureCookies),
      );
      return reply.send({
        schemaVersion: 1,
        sessionId: verified.sessionId,
        status: manifest.status,
        tracks: manifest.tracks.map((track) => ({
          timelineOffsetMs: track.timelineOffsetMs,
          url: `/recordings/s/${verified.sessionId}/tracks/${track.index}`,
        })),
      });
    });
    app.head("/recordings/s/:sessionId/tracks/:trackIndex", async (request, reply) => {
      const access = verifySession(request, options.access);
      if (access === null) {
        return sendNotFound(reply);
      }
      try {
        const descriptor = await options.playback.describeTrack({
          meetingId: access.meetingId,
          signal: requestSignal(request, reply),
          trackIndex: trackIndex(request),
        });
        setAudioHeaders(reply, descriptor);
        return reply.code(200).send();
      } catch (error) {
        return sendPlaybackError(reply, error);
      }
    });
    app.get("/recordings/s/:sessionId/tracks/:trackIndex", {
      exposeHeadRoute: false,
    }, async (request, reply) => {
      const access = verifySession(request, options.access);
      if (access === null) {
        return sendNotFound(reply);
      }
      const range = parseRangeHeader(request.headers.range);
      if (range === null) {
        return sendInvalidRange(reply, options.playback, access, request);
      }
      try {
        const audio = await options.playback.readTrack({
          meetingId: access.meetingId,
          ...(range === undefined ? {} : { range }),
          signal: requestSignal(request, reply),
          trackIndex: trackIndex(request),
        });
        setAudioHeaders(reply, audio);
        reply.header("content-length", audio.contentLength);
        if (audio.range !== undefined) {
          reply.header(
            "content-range",
            `bytes ${audio.range.start}-${audio.range.end}/${audio.sizeBytes}`,
          );
          reply.code(206);
        }
        return reply.send(Readable.from(audio.body));
      } catch (error) {
        return sendPlaybackError(reply, error);
      }
    });
    done();
  };
}

function parseRangeHeader(
  value: string | undefined,
): RecordingPlaybackByteRange | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (match === null) {
    return null;
  }
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText.length === 0 && endText.length === 0) {
    return null;
  }
  if (startText.length === 0) {
    const suffixLength = Number(endText);
    return Number.isSafeInteger(suffixLength) && suffixLength > 0
      ? { suffixLength }
      : null;
  }
  const start = Number(startText);
  const end = endText.length === 0 ? undefined : Number(endText);
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    (end !== undefined && (!Number.isSafeInteger(end) || end < start))
  ) {
    return null;
  }
  return end === undefined ? { start } : { end, start };
}

function verifyBearer(
  request: FastifyRequest,
  access: RecordingPlaybackAccess,
): VerifiedRecordingPlaybackAccess | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") === true
    ? access.verify(authorization.slice("Bearer ".length))
    : null;
}

function verifySession(
  request: FastifyRequest,
  access: RecordingPlaybackAccess,
): VerifiedRecordingPlaybackAccess | null {
  const params = request.params as { readonly sessionId?: string };
  const token = parseCookies(request.headers.cookie)[accessCookieName];
  if (token === undefined || params.sessionId === undefined) {
    return null;
  }
  const verified = access.verify(token);
  return verified?.sessionId === params.sessionId ? verified : null;
}

function createSessionCookie(
  access: VerifiedRecordingPlaybackAccess,
  secure: boolean,
): string {
  return [
    `${accessCookieName}=${access.token}`,
    `Path=/recordings/s/${access.sessionId}`,
    `Max-Age=${sessionCookieMaximumAgeSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function parseCookies(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined) {
    return {};
  }
  return Object.fromEntries(value.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      return [];
    }
    return [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]];
  }));
}

function trackIndex(request: FastifyRequest): number {
  const params = request.params as { readonly trackIndex?: string };
  return Number(params.trackIndex);
}

function requestSignal(
  request: FastifyRequest,
  reply: FastifyReply,
): AbortSignal {
  const controller = new AbortController();
  request.raw.once("aborted", () => {
    controller.abort();
  });
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  });
  return controller.signal;
}

function setPageSecurityHeaders(reply: FastifyReply): void {
  setPrivateHeaders(reply);
  reply.header(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

function setStaticAssetHeaders(reply: FastifyReply): void {
  reply.header("cache-control", "public, max-age=3600");
  reply.header("x-content-type-options", "nosniff");
}

function setPrivateHeaders(reply: FastifyReply): void {
  reply.header("cache-control", "private, no-store");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-robots-tag", "noindex, nofollow, noarchive");
}

function setAudioHeaders(
  reply: FastifyReply,
  descriptor: { readonly contentType: string; readonly eTag?: string; readonly sizeBytes: number },
): void {
  setPrivateHeaders(reply);
  reply.header("accept-ranges", "bytes");
  reply.header("content-type", descriptor.contentType);
  reply.header("content-length", descriptor.sizeBytes);
  if (descriptor.eTag !== undefined) {
    reply.header("etag", descriptor.eTag);
  }
}

async function sendInvalidRange(
  reply: FastifyReply,
  playback: GetRecordingPlayback,
  access: VerifiedRecordingPlaybackAccess,
  request: FastifyRequest,
) {
  try {
    const descriptor = await playback.describeTrack({
      meetingId: access.meetingId,
      signal: requestSignal(request, reply),
      trackIndex: trackIndex(request),
    });
    setPrivateHeaders(reply);
    reply.header("content-range", `bytes */${descriptor.sizeBytes}`);
    return reply.code(416).send();
  } catch (error) {
    return sendPlaybackError(reply, error);
  }
}

function sendPlaybackError(reply: FastifyReply, error: unknown) {
  if (error instanceof RecordingPlaybackRangeNotSatisfiableError) {
    setPrivateHeaders(reply);
    reply.header("content-range", `bytes */${error.sizeBytes}`);
    return reply.code(416).send();
  }
  if (
    error instanceof RecordingPlaybackNotReadyError ||
    error instanceof RecordingPlaybackTrackNotFoundError ||
    error instanceof RecordingPlaybackAudioUnavailableError
  ) {
    return sendNotFound(reply);
  }
  throw error;
}

function sendNotFound(reply: FastifyReply) {
  setPrivateHeaders(reply);
  return reply.code(404).send({ code: "NOT_FOUND" });
}
