import assert from "node:assert/strict";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand } from "@aws-sdk/lib-dynamodb";
const base = process.env.SMOKE_API_URL ?? "http://localhost:4100";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Smoke test is local-only.");
let token, postId, seriesId, commentId, jobId;
const email = `smoke-${Date.now()}@example.com`;
async function request(method, path, data, expected = 200) {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
try {
  assert.equal((await request("GET", "/api/posts")).page, 1);
  token = (await request("POST", "/api/auth/register", { name: "Synthetic smoke", email, password: "synthetic-test-password" }, 201)).token;
  assert(token);
  assert((await request("POST", "/api/auth/login", { email, password: "synthetic-test-password" })).token);
  seriesId = (await request("POST", "/api/series", { title: "Smoke walks" }, 201))._id;
  postId = (await request("POST", "/api/posts", { title: "Synthetic smoke post", postType: "travel", series: { seriesId, part: 1 }, searchBy: ["smoke"] }, 201))._id;
  assert.equal((await request("GET", `/api/posts/${postId}`)).visited, 1);
  await request("PUT", `/api/posts/${postId}`, { gist: "Updated" });
  assert.equal((await request("PUT", `/api/posts/${postId}/status`, { status: "published" })).status, "published");
  const listed = await request("GET", "/api/posts?status=published&search=smoke");
  assert.equal(listed.total, 1, JSON.stringify(listed));
  commentId = (await request("POST", `/api/posts/${postId}/comments`, { username: "Reader", title: "Synthetic", description: "Local test" }, 201))._id;
  await request("GET", `/api/posts/${postId}/comments/${commentId}`);
  assert.equal((await request("GET", `/api/posts/${postId}/comments`)).items.length, 1);
  await request("PUT", `/api/posts/${postId}/comments/${commentId}`, { title: "Edited" });
  await request("PUT", `/api/posts/${postId}/comments/${commentId}/reply`, { reply: "Thanks" });
  await request("DELETE", `/api/series/${seriesId}`, undefined, 409);
  jobId = (await request("POST", "/api/summary", { content: "Synthetic local smoke content" }, 202)).jobId;
  let state;
  for (let attempt = 0; attempt < 20; attempt++) {
    state = await request("GET", `/api/worker/${jobId}`);
    if (state.status === "failed") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(state.status, "failed"); assert.match(state.error, /OPENAI_API_KEY/);
  await request("DELETE", `/api/posts/${postId}/comments/${commentId}`); commentId = undefined;
  await request("DELETE", `/api/posts/${postId}`); postId = undefined;
  await request("DELETE", `/api/series/${seriesId}`); seriesId = undefined;
  console.log("HTTP smoke passed: auth, post/status CRUD, lists, comments/reply, series and actual async worker polling.");
} finally {
  if (commentId && postId) await request("DELETE", `/api/posts/${postId}/comments/${commentId}`);
  if (postId) await request("DELETE", `/api/posts/${postId}`);
  if (seriesId) await request("DELETE", `/api/series/${seriesId}`);
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname)) throw new Error("Cleanup requires local DynamoDB.");
  const raw = new DynamoDBClient({ endpoint, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
  const db = DynamoDBDocumentClient.from(raw);
  await db.send(new DeleteCommand({ TableName: "batayan-serverless-dev-users", Key: { email } }));
  if (jobId) await db.send(new DeleteCommand({ TableName: "batayan-serverless-dev-jobs", Key: { _id: jobId } }));
  raw.destroy();
}
