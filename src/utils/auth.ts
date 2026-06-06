import type { APIGatewayProxyEventV2 } from "aws-lambda";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getEnv } from "../config/env.js";
import { HttpError } from "./http.js";

type TokenPayload = {
  sub: string;
  email: string;
  role: string;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, getEnv().jwtSecret, { expiresIn: "7d" });
}

export function requireAuth(event: APIGatewayProxyEventV2): TokenPayload {
  const header = event.headers.authorization ?? event.headers.Authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!token) {
    throw new HttpError(401, "Bearer token is required.");
  }

  try {
    return jwt.verify(token, getEnv().jwtSecret) as TokenPayload;
  } catch {
    throw new HttpError(401, "Bearer token is invalid or expired.");
  }
}
