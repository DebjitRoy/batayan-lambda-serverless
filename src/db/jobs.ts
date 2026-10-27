import { conditional, getItem, putItem, updateItem, type Item } from "./dynamodb.js";
import type { Job } from "./entities.js";
import { newId } from "../utils/ids.js";
export const findJob = (id: string) => getItem<Job>("JOBS", { _id: id });
export const createJob = (jobType: Job["jobType"], data: Job["data"]) => {
  const now = new Date().toISOString();
  return putItem<Job>("JOBS", { _id: newId(), jobType, data, status: "pending", error: "", createdAt: now, updatedAt: now });
};
export async function claimJob(id: string): Promise<Job | undefined> {
  try { return await updateItem<Job>("JOBS", { _id: id }, { status: "processing", error: "", updatedAt: new Date().toISOString() }, { expression: "#status = :pending", names: { "#status": "status" }, values: { ":pending": "pending" } }); }
  catch (error) { if (conditional(error)) return undefined; throw error; }
}
export async function finishJob(id: string, values: Item, expected = "processing"): Promise<void> {
  try { await updateItem<Job>("JOBS", { _id: id }, { ...values, updatedAt: new Date().toISOString() }, { expression: "#status = :expected", names: { "#status": "status" }, values: { ":expected": expected } }); }
  catch (error) { if (!conditional(error)) throw error; }
}
