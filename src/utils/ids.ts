import mongoose from "mongoose";
import { HttpError } from "./http.js";

export function assertObjectId(id: string, label = "id"): string {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new HttpError(400, `Invalid ${label}.`);
  }

  return id;
}
