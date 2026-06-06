import mongoose from "mongoose";
import { getEnv } from "../config/env.js";

let connection: Promise<typeof mongoose> | null = null;

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (!connection) {
    const { mongodbUri } = getEnv();
    mongoose.set("strictQuery", true);
    connection = mongoose.connect(mongodbUri, {
      serverSelectionTimeoutMS: 5000
    });
  }

  return connection;
}

export function resetDatabaseConnectionForTests(): void {
  connection = null;
}
