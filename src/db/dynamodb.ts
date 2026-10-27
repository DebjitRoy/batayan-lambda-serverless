import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, QueryCommand, PutCommand, UpdateCommand, DeleteCommand, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import { HttpError } from "../utils/http.js";

let client: DynamoDBDocumentClient;
export function getDocumentClient(): DynamoDBDocumentClient {
  if (!client) {
    const endpoint = process.env.DYNAMODB_ENDPOINT;
    if (endpoint && (!process.env.IS_OFFLINE && process.env.NODE_ENV !== "test")) throw new Error("DYNAMODB_ENDPOINT is only allowed offline or in tests.");
    if (endpoint && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname)) throw new Error("DYNAMODB_ENDPOINT must be local.");
    client = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.AWS_REGION ?? "us-east-1", maxAttempts: 5,
      ...(endpoint ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {})
    }), { marshallOptions: { removeUndefinedValues: true } });
  }
  return client;
}
export type Table = "POSTS" | "COMMENTS" | "USERS" | "SERIES" | "JOBS";
export function table(name: Table): string {
  const value = process.env[`${name}_TABLE`];
  if (!value) throw new Error(`${name}_TABLE is not configured.`);
  return value;
}
export type Item = Record<string, any>;
export function publicItem<T>(item: Item): T {
  const { _version, seriesId, recordKey, memberCount, ...value } = item;
  return value as T;
}
export async function getItem<T>(name: Table, Key: Item): Promise<T | undefined> {
  const result = await getDocumentClient().send(new GetCommand({ TableName: table(name), Key, ConsistentRead: true }));
  return result.Item ? publicItem<T>(result.Item) : undefined;
}
export async function scanItems<T>(name: Table): Promise<T[]> {
  const items: T[] = []; let key: Item | undefined;
  do {
    const result = await getDocumentClient().send(new ScanCommand({ TableName: table(name), ExclusiveStartKey: key, ConsistentRead: true }));
    for (const item of result.Items ?? []) if (name !== "SERIES" || item.recordKey === "META") items.push(publicItem<T>(item));
    key = result.LastEvaluatedKey;
  } while (key);
  return items;
}
export async function queryItems<T>(input: QueryCommandInput): Promise<T[]> {
  const items: T[] = []; let key: Item | undefined;
  do {
    const result = await getDocumentClient().send(new QueryCommand({ ...input, ConsistentRead: true, ExclusiveStartKey: key }));
    items.push(...(result.Items ?? []).map(item => publicItem<T>(item)));
    key = result.LastEvaluatedKey;
  } while (key);
  return items;
}
export function conditional(error: unknown): boolean { return error instanceof Error && error.name === "ConditionalCheckFailedException"; }
export async function putItem<T extends Item>(name: Table, item: T, keyName = "_id"): Promise<T> {
  await getDocumentClient().send(new PutCommand({ TableName: table(name), Item: item, ConditionExpression: "attribute_not_exists(#key)", ExpressionAttributeNames: { "#key": keyName } }));
  return publicItem<T>(item);
}
export async function updateItem<T>(name: Table, Key: Item, values: Item, condition?: { expression: string; names?: Record<string, string>; values?: Item }): Promise<T> {
  const fields = Object.entries(values).filter(([, value]) => value !== undefined);
  if (!fields.length) {
    const existing = await getItem<T>(name, Key);
    if (!existing) throw new HttpError(404, "Record not found.");
    return existing;
  }
  try {
    const result = await getDocumentClient().send(new UpdateCommand({
      TableName: table(name), Key, ReturnValues: "ALL_NEW",
      UpdateExpression: `SET ${fields.map((_, i) => `#f${i} = :v${i}`).join(", ")}`,
      ConditionExpression: `attribute_exists(#key)${condition ? ` AND (${condition.expression})` : ""}`,
      ExpressionAttributeNames: { "#key": Object.keys(Key)[0]!, ...Object.fromEntries(fields.map(([key], i) => [`#f${i}`, key])), ...condition?.names },
      ExpressionAttributeValues: { ...Object.fromEntries(fields.map(([, value], i) => [`:v${i}`, value])), ...condition?.values }
    }));
    return publicItem<T>(result.Attributes!);
  } catch (error) { if (conditional(error) && !condition) throw new HttpError(404, "Record not found."); throw error; }
}
export async function deleteItem(name: Table, Key: Item): Promise<void> {
  try { await getDocumentClient().send(new DeleteCommand({ TableName: table(name), Key, ConditionExpression: "attribute_exists(#key)", ExpressionAttributeNames: { "#key": Object.keys(Key)[0]! } })); }
  catch (error) { if (conditional(error)) throw new HttpError(404, "Record not found."); throw error; }
}
