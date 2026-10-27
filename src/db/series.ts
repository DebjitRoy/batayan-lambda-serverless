import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { conditional, getDocumentClient, getItem, putItem, scanItems, table, updateItem, type Item } from "./dynamodb.js";
import type { Series } from "./entities.js";
import { newId } from "../utils/ids.js";
import { HttpError } from "../utils/http.js";
export const allSeries = () => scanItems<Series>("SERIES");
export const findSeries = (id: string) => getItem<Series>("SERIES", { seriesId: id, recordKey: "META" });
export async function createSeries(values: Omit<Series, "_id" | "createdAt">): Promise<Series> {
  const _id = newId();
  return putItem<Series & Item>("SERIES", { ...values, _id, createdAt: new Date().toISOString(), seriesId: _id, recordKey: "META", memberCount: 0 } as Series & Item, "seriesId");
}
export async function updateSeries(id: string, values: Item): Promise<Series> {
  if (!(await findSeries(id))) throw new HttpError(404, "Series not found.");
  try { return await updateItem<Series>("SERIES", { seriesId: id, recordKey: "META" }, values); }
  catch (error) { if (error instanceof HttpError && error.statusCode === 404) throw new HttpError(404, "Series not found."); throw error; }
}
export async function deleteSeries(id: string): Promise<void> {
  try { await getDocumentClient().send(new DeleteCommand({ TableName: table("SERIES"), Key: { seriesId: id, recordKey: "META" }, ConditionExpression: "attribute_exists(seriesId) AND memberCount = :zero", ExpressionAttributeValues: { ":zero": 0 } })); }
  catch (error) {
    if (conditional(error)) {
      if (!(await findSeries(id))) throw new HttpError(404, "Series not found.");
      throw new HttpError(409, "Series has posts and cannot be deleted.");
    }
    throw error;
  }
}
