import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
export async function createLocalTables(prefix = "batayan-serverless-dev") {
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname)) throw new Error("Local table setup requires a loopback endpoint.");
  const client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" }, maxAttempts: 3 });
  for (const [name, partition, sort] of [["posts", "_id"], ["comments", "post", "_id"], ["users", "email"], ["series", "seriesId", "recordKey"], ["jobs", "_id"]]) {
    const TableName = `${prefix}-${name}`;
    try { await client.send(new DescribeTableCommand({ TableName })); }
    catch (error) {
      if (error.name !== "ResourceNotFoundException") throw error;
      await client.send(new CreateTableCommand({ TableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [partition, sort].filter(Boolean).map(AttributeName => ({ AttributeName, AttributeType: "S" })), KeySchema: [{ AttributeName: partition, KeyType: "HASH" }, ...(sort ? [{ AttributeName: sort, KeyType: "RANGE" }] : [])] }));
    }
  }
  client.destroy();
}
if (process.argv[1]?.endsWith("local-tables.mjs")) { await createLocalTables(); console.log("Local tables ready."); }
