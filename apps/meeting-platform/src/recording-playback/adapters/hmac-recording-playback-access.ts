import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const tokenVersion = "v1";
const maximumTokenLength = 1_024;

export interface VerifiedRecordingPlaybackAccess {
  readonly meetingId: string;
  readonly sessionId: string;
  readonly token: string;
}

export interface RecordingPlaybackAccess {
  issueUrl(meetingId: string): string;
  verify(token: string): VerifiedRecordingPlaybackAccess | null;
}

export class HmacRecordingPlaybackAccess implements RecordingPlaybackAccess {
  readonly #publicOrigin: string;
  readonly #secret: Buffer;

  public constructor(input: {
    readonly publicBaseUrl: string;
    readonly secret: string;
  }) {
    const publicUrl = new URL(input.publicBaseUrl);
    if (
      !["http:", "https:"].includes(publicUrl.protocol) ||
      publicUrl.username.length > 0 ||
      publicUrl.password.length > 0 ||
      publicUrl.pathname !== "/" ||
      publicUrl.search.length > 0 ||
      publicUrl.hash.length > 0
    ) {
      throw new Error("Recording playback public URL must be an HTTP(S) origin");
    }
    if (Buffer.byteLength(input.secret, "utf8") < 32) {
      throw new Error("Recording playback signing secret must contain at least 32 bytes");
    }
    this.#publicOrigin = publicUrl.origin;
    this.#secret = Buffer.from(input.secret, "utf8");
  }

  public issueUrl(meetingId: string): string {
    return `${this.#publicOrigin}/recordings/playback#${this.issueToken(meetingId)}`;
  }

  public verify(token: string): VerifiedRecordingPlaybackAccess | null {
    if (token.length === 0 || token.length > maximumTokenLength) {
      return null;
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== tokenVersion) {
      return null;
    }
    const payload = parts[1];
    const suppliedSignature = parts[2];
    if (payload === undefined || suppliedSignature === undefined) {
      return null;
    }
    const expectedSignature = this.sign(`${tokenVersion}.${payload}`);
    const expectedBytes = Buffer.from(expectedSignature, "utf8");
    const suppliedBytes = Buffer.from(suppliedSignature, "utf8");
    if (
      expectedBytes.length !== suppliedBytes.length ||
      !timingSafeEqual(expectedBytes, suppliedBytes)
    ) {
      return null;
    }
    try {
      const meetingId = Buffer.from(payload, "base64url").toString("utf8");
      if (
        meetingId.length === 0 ||
        meetingId.length > 256 ||
        containsControlCharacters(meetingId) ||
        Buffer.from(meetingId, "utf8").toString("base64url") !== payload
      ) {
        return null;
      }
      return {
        meetingId,
        sessionId: createHash("sha256").update(token).digest("base64url").slice(0, 32),
        token,
      };
    } catch {
      return null;
    }
  }

  private issueToken(meetingId: string): string {
    if (
      meetingId.length === 0 ||
      meetingId.length > 256 ||
      containsControlCharacters(meetingId)
    ) {
      throw new Error("Recording playback meeting ID is invalid");
    }
    const payload = Buffer.from(meetingId, "utf8").toString("base64url");
    const unsigned = `${tokenVersion}.${payload}`;
    return `${unsigned}.${this.sign(unsigned)}`;
  }

  private sign(value: string): string {
    return createHmac("sha256", this.#secret).update(value).digest("base64url");
  }
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) {
      return true;
    }
  }
  return false;
}
