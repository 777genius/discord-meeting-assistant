import type { JsonObject } from "./subscription-runtime-contract.js";

export function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (parsed === undefined) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return parsed;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function integerValue(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be an integer`);
  }
  return parsed;
}

export function nonNegativeFiniteNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return parsed;
}

export function booleanValue(value: unknown): boolean {
  return value === true;
}

export function enumValue(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

export function jsonObject(value: unknown, field: string): JsonObject {
  const text = requiredString(value, field);
  return recordValue(JSON.parse(text) as unknown, field) as JsonObject;
}
