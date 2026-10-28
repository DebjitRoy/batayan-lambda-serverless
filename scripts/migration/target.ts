import { DynamoDBClient, DescribeTableCommand, type TableDescription } from "@aws-sdk/client-dynamodb";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { setTimeout as sleep } from "node:timers/promises";
import { collections, MigrationError, type Collection, type Document, type RecordToImport } from "./backup.js";

export type TargetOptions = { accountId: string; region: string; stage: string; endpoint?: string; writeUnitsPerSecond?: number };
export const tableKeys: Record<Collection, string[]> = {
  users: ["email"], posts: ["_id"], comments: ["post", "_id"], series: ["seriesId", "recordKey"], jobs: ["_id"]
};
export function validateTargetOptions(options: TargetOptions): void {
  if (!/^[a-z][a-z0-9-]+-\d+$/.test(options.region)) throw new MigrationError("INVALID_REGION");
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(options.stage)) throw new MigrationError("INVALID_STAGE");
  if (options.endpoint) {
    let url: URL;
    try { url = new URL(options.endpoint); } catch { throw new MigrationError("INVALID_ENDPOINT"); }
    if (!['http:', 'https:'].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new MigrationError("ENDPOINT_MUST_BE_LOOPBACK");
    if (options.accountId !== "local") throw new MigrationError("LOCAL_ACCOUNT_REQUIRED");
    if (["prod", "dev"].includes(options.stage)) throw new MigrationError("USE_ISOLATED_LOCAL_STAGE");
  } else if (!/^\d{12}$/.test(options.accountId)) throw new MigrationError("EXPLICIT_AWS_ACCOUNT_REQUIRED");
  if (options.writeUnitsPerSecond !== undefined && (!Number.isFinite(options.writeUnitsPerSecond) || options.writeUnitsPerSecond <= 0 || options.writeUnitsPerSecond > 50000)) throw new MigrationError("INVALID_WRITE_RATE");
}
export function checkTable(description: TableDescription, collection: Collection, options: TargetOptions): void {
  if (description.TableStatus !== "ACTIVE") throw new MigrationError("TARGET_TABLE_NOT_ACTIVE");
  const keys = [...(description.KeySchema ?? [])].sort((a, b) => (a.KeyType === "HASH" ? -1 : 1) - (b.KeyType === "HASH" ? -1 : 1)).map(key => key.AttributeName);
  if (JSON.stringify(keys) !== JSON.stringify(tableKeys[collection]) || tableKeys[collection].some(key => !description.AttributeDefinitions?.some(attribute => attribute.AttributeName === key && attribute.AttributeType === "S"))) throw new MigrationError("TARGET_KEY_SCHEMA_MISMATCH");
  if (!options.endpoint) {
    const arn = description.TableArn?.match(/^arn:[^:]+:dynamodb:([^:]+):(\d{12}):table\/(.+)$/);
    if (!arn || arn[1] !== options.region || arn[2] !== options.accountId || arn[3] !== `batayan-serverless-${options.stage}-${collection}`) throw new MigrationError("TARGET_TABLE_IDENTITY_MISMATCH");
    if (description.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST") throw new MigrationError("PROVISIONED_TARGET_REQUIRED");
  }
}
export interface MigrationTarget {
  inspect(): Promise<void>;
  scan(collection: Collection, signal?: AbortSignal): AsyncIterable<Document>;
  get(record: RecordToImport): Promise<Document | undefined>;
  put(record: RecordToImport, signal?: AbortSignal): Promise<void>;
  close(): void;
}
export function abortIfNeeded(signal?: AbortSignal): void { if (signal?.aborted) throw new MigrationError("INTERRUPTED"); }
export async function waitForUnits(units: number, rate: number, signal?: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  try { await sleep(Math.ceil(units / rate * 1000), undefined, { signal }); }
  catch (error) { if (signal?.aborted) throw new MigrationError("INTERRUPTED"); throw error; }
}
export class DynamoTarget implements MigrationTarget {
  readonly raw: DynamoDBClient;
  readonly document: DynamoDBDocumentClient;
  private readRates = new Map<Collection, number>();
  private writeRates = new Map<Collection, number>();
  private inspected = false;
  constructor(readonly options: TargetOptions) {
    validateTargetOptions(options);
    this.raw = new DynamoDBClient({
      region: options.region, maxAttempts: 5, retryMode: "standard",
      ...(options.endpoint ? { endpoint: options.endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {})
    });
    this.document = DynamoDBDocumentClient.from(this.raw, { marshallOptions: { removeUndefinedValues: false } });
  }
  table(collection: Collection): string { return `batayan-serverless-${this.options.stage}-${collection}`; }
  async inspect(): Promise<void> {
    if (!this.options.endpoint) {
      const sts = new STSClient({ region: this.options.region, maxAttempts: 5, retryMode: "standard" });
      try { if ((await sts.send(new GetCallerIdentityCommand({}))).Account !== this.options.accountId) throw new MigrationError("AWS_ACCOUNT_MISMATCH"); }
      finally { sts.destroy(); }
    }
    for (const collection of collections) {
      const { Table } = await this.raw.send(new DescribeTableCommand({ TableName: this.table(collection) }));
      if (!Table) throw new MigrationError("TARGET_TABLE_MISSING");
      checkTable(Table, collection, this.options);
      const localRate = 10000;
      this.readRates.set(collection, this.options.endpoint ? localRate : Math.max(0.1, (Table.ProvisionedThroughput?.ReadCapacityUnits ?? 1) * 0.8));
      const writeRate = this.options.endpoint ? localRate : Math.max(0.1, (Table.ProvisionedThroughput?.WriteCapacityUnits ?? 1) * 0.8);
      this.writeRates.set(collection, Math.min(this.options.writeUnitsPerSecond ?? writeRate, writeRate));
    }
    this.inspected = true;
  }
  private requireInspection(): void { if (!this.inspected) throw new MigrationError("TARGET_NOT_INSPECTED"); }
  async *scan(collection: Collection, signal?: AbortSignal): AsyncIterable<Document> {
    this.requireInspection();
    let key: Record<string, unknown> | undefined;
    do {
      abortIfNeeded(signal);
      const result = await this.document.send(new ScanCommand({ TableName: this.table(collection), ConsistentRead: true, ExclusiveStartKey: key, Limit: 25, ReturnConsumedCapacity: "TOTAL" }));
      for (const item of result.Items ?? []) yield item as Document;
      key = result.LastEvaluatedKey;
      await waitForUnits(result.ConsumedCapacity?.CapacityUnits ?? 1, this.readRates.get(collection)!, signal);
    } while (key);
  }
  private key(record: RecordToImport): Document { return Object.fromEntries(tableKeys[record.collection].map(key => [key, record.item[key]!])); }
  async get(record: RecordToImport): Promise<Document | undefined> {
    this.requireInspection();
    const result = await this.document.send(new GetCommand({ TableName: this.table(record.collection), Key: this.key(record), ConsistentRead: true }));
    return result.Item as Document | undefined;
  }
  async put(record: RecordToImport, signal?: AbortSignal): Promise<void> {
    this.requireInspection();
    await waitForUnits(Math.ceil(record.bytes / 1024), this.writeRates.get(record.collection)!, signal);
    await this.document.send(new PutCommand({
      TableName: this.table(record.collection), Item: record.item,
      ConditionExpression: "attribute_not_exists(#partition)", ExpressionAttributeNames: { "#partition": tableKeys[record.collection][0]! }
    }));
  }
  close(): void { this.raw.destroy(); }
}
