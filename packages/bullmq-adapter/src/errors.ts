import { parsePostCallFailureCode } from "./contracts.js";

export interface PostCallFailureClassification {
  readonly code: string;
  readonly retryable: boolean;
}

export type PostCallFailureClassifier = (
  error: unknown,
) => PostCallFailureClassification;

abstract class PostCallProcessingError extends Error {
  public abstract readonly retryable: boolean;
  public readonly code: string;

  protected constructor(code: string) {
    const validatedCode = parsePostCallFailureCode(code);
    super(`Post-call processing failed: ${validatedCode}`);
    this.code = validatedCode;
  }
}

export class RetryablePostCallError extends PostCallProcessingError {
  public readonly retryable = true;

  public constructor(code: string) {
    super(code);
    this.name = "RetryablePostCallError";
  }
}

export class NonRetryablePostCallError extends PostCallProcessingError {
  public readonly retryable = false;

  public constructor(code: string) {
    super(code);
    this.name = "NonRetryablePostCallError";
  }
}

export function classifyPostCallFailure(
  error: unknown,
): PostCallFailureClassification {
  if (
    error instanceof RetryablePostCallError ||
    error instanceof NonRetryablePostCallError
  ) {
    return Object.freeze({ code: error.code, retryable: error.retryable });
  }
  return Object.freeze({ code: "UNEXPECTED_FAILURE", retryable: true });
}

export function safelyClassifyPostCallFailure(
  error: unknown,
  classifier: PostCallFailureClassifier = classifyPostCallFailure,
): PostCallFailureClassification {
  try {
    const classification = classifier(error);
    if (typeof classification.retryable !== "boolean") {
      throw new TypeError("retryable classification must be boolean");
    }
    return Object.freeze({
      code: parsePostCallFailureCode(classification.code),
      retryable: classification.retryable,
    });
  } catch {
    return Object.freeze({ code: "UNEXPECTED_FAILURE", retryable: true });
  }
}
