import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { ZodError, type ZodSchema } from "zod";

export type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: Json
  ) {
    super(message);
  }
}

export function json(statusCode: number, body: Json): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

export function parseJsonBody<T>(event: APIGatewayProxyEventV2, schema: ZodSchema<T>): T {
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "{}";
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }

  return schema.parse(parsed);
}

export async function handle(handler: () => Promise<APIGatewayProxyResultV2>): Promise<APIGatewayProxyResultV2> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.statusCode, { error: error.message, details: error.details ?? null });
    }

    if (error instanceof ZodError) {
      return json(400, { error: "Validation failed.", details: error.issues });
    }

    console.error(error);
    return json(500, { error: "Internal server error." });
  }
}

export function pathParam(event: APIGatewayProxyEventV2, key: string): string {
  const value = event.pathParameters?.[key];

  if (!value) {
    throw new HttpError(400, `Missing path parameter: ${key}`);
  }

  return value;
}

export function queryNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}
