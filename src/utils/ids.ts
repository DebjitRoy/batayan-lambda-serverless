import { randomBytes } from "node:crypto";
import { HttpError } from "./http.js";

export function newId(): string { return randomBytes(12).toString("hex"); }
export function assertObjectId(id: string, label = "id"): string {
  if (!/^[a-f\d]{24}$/i.test(id)) {
    throw new HttpError(400, `Invalid ${label}.`);
  }

  return id.toLowerCase();
}
