import pino, {
  type Logger as PinoLogger,
  type LoggerOptions,
} from "pino";

import { currentCorrelation } from "./correlation.js";
import type { LogFields, Logger } from "./contracts.js";
import {
  REDACTED_VALUE,
  sanitizeLogFields,
  sanitizeLogMessage,
  type LogEnvironment,
} from "./sanitization.js";

export type LogLevel = "debug" | "error" | "info" | "warn";

export interface LogDestination {
  write(message: string): unknown;
}

export interface JsonLoggerOptions {
  readonly baseContext?: LogFields;
  readonly destination?: LogDestination;
  readonly environment?: LogEnvironment;
  readonly level?: LogLevel;
  readonly timestamp?: boolean;
}

const DEFENSIVE_REDACTION_PATHS = [
  "authorization",
  "auth",
  "cookie",
  "password",
  "prompt",
  "secret",
  "token",
  "transcript",
  "audio",
  "providerOutput",
  "*.authorization",
  "*.auth",
  "*.cookie",
  "*.password",
  "*.prompt",
  "*.secret",
  "*.token",
  "*.transcript",
  "*.audio",
  "*.providerOutput",
] as const;

function mergeFields(...records: readonly (LogFields | undefined)[]): LogFields {
  const output: Record<string, unknown> = {};
  for (const record of records) {
    if (record === undefined) {
      continue;
    }
    for (const key of Object.keys(record).toSorted()) {
      output[key] = record[key];
    }
  }

  return Object.freeze(output);
}

class PinoJsonLogger implements Logger {
  public constructor(
    private readonly engine: PinoLogger,
    private readonly environment: LogEnvironment,
    private readonly context: LogFields,
  ) {}

  public child(context: LogFields): Logger {
    return new PinoJsonLogger(
      this.engine,
      this.environment,
      sanitizeLogFields(mergeFields(this.context, context), this.environment),
    );
  }

  public debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  public error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  public flush(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.engine.flush((error?: Error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error("log flush failed"));
      }
    });
  }

  public info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  public warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    const correlation = currentCorrelation();
    const correlationFields =
      correlation === undefined ? undefined : { ...correlation };
    const safeFields = sanitizeLogFields(
      mergeFields(this.context, fields, correlationFields),
      this.environment,
    );
    const safeMessage = sanitizeLogMessage(message);

    this.engine[level](safeFields, safeMessage);
  }
}

export function createJsonLogger(options: JsonLoggerOptions = {}): Logger {
  const environment = options.environment ?? "production";
  const loggerOptions: LoggerOptions = {
    base: null,
    formatters: {
      level: (label) => ({ level: label }),
    },
    level: options.level ?? "info",
    messageKey: "message",
    redact: {
      censor: REDACTED_VALUE,
      paths: [...DEFENSIVE_REDACTION_PATHS],
    },
    timestamp:
      options.timestamp === false ? false : pino.stdTimeFunctions.isoTime,
  };
  const engine =
    options.destination === undefined
      ? pino(loggerOptions)
      : pino(loggerOptions, options.destination);

  return new PinoJsonLogger(
    engine,
    environment,
    sanitizeLogFields(options.baseContext ?? {}, environment),
  );
}

export async function flushLoggers(loggers: readonly Logger[]): Promise<void> {
  const results = await Promise.allSettled(loggers.map((logger) => logger.flush()));
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(result.reason as unknown);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "one or more loggers failed to flush");
  }
}
