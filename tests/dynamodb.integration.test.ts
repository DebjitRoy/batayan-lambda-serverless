import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { PutCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
const mocks = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined), completion: vi.fn() }));
vi.mock("../src/utils/worker.js", () => ({ invokeWorker: mocks.invoke }));
vi.mock("../src/utils/s3.js", () => ({ uploadObject: vi.fn().mockResolvedValue("https://example.com/image.jpg"), publicObjectUrl: () => "https://example.com/image.jpg", createUploadUrl: vi.fn().mockResolvedValue("https://example.com/presigned") }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: mocks.completion } }; } }));
import * as posts from "../src/handlers/posts.js";
import * as comments from "../src/handlers/comments.js";
import * as auth from "../src/handlers/auth.js";
import * as series from "../src/handlers/series.js";
import * as uploads from "../src/handlers/uploads.js";
import * as grammar from "../src/handlers/grammerCheck.js";
import { createSummary } from "../src/handlers/summary.js";
import { createJob, findJob } from "../src/db/jobs.js";
import { createPost, updatePost, visitPost } from "../src/db/posts.js";
import { getDocumentClient, scanItems, queryItems } from "../src/db/dynamodb.js";
import { newId } from "../src/utils/ids.js";
import { signToken } from "../src/utils/auth.js";
import { hash } from "bcryptjs";
import { post as legacyPost, user as legacyUser } from "./fixtures/legacy.js";

const body = (value: unknown): any => JSON.parse((value as { body: string }).body);
const status = (value: unknown) => (value as { statusCode: number }).statusCode;
let token: string;
function event(payload?: unknown, pathParameters = {}, queryStringParameters = {}, authenticated = false): APIGatewayProxyEventV2 {
  return { version: "2.0", headers: authenticated ? { authorization: `Bearer ${token}` } : {}, body: payload === undefined ? undefined : JSON.stringify(payload), pathParameters, queryStringParameters, isBase64Encoded: false } as APIGatewayProxyEventV2;
}
describe.skipIf(!process.env.DYNAMODB_ENDPOINT)("DynamoDB Local handler and transaction integration", () => {
  let client: DynamoDBClient;
  const prefix = `batayan-test-${Date.now()}`;
  beforeAll(async () => {
    const endpoint = process.env.DYNAMODB_ENDPOINT!;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname)) throw new Error("Tests require local DynamoDB.");
    delete process.env.MONGODB_URI;
    process.env.JWT_SECRET = "integration-test-secret"; process.env.S3_BUCKET = "synthetic-test"; process.env.OPENAI_API_KEY = "synthetic-key";
    client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
    for (const [name, pk, sk] of [["POSTS", "_id"], ["COMMENTS", "post", "_id"], ["USERS", "email"], ["SERIES", "seriesId", "recordKey"], ["JOBS", "_id"]]) {
      const TableName = `${prefix}-${name!.toLowerCase()}`;
      process.env[`${name}_TABLE`] = TableName;
      await client.send(new CreateTableCommand({ TableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [pk, sk].filter((s): s is string => Boolean(s)).map(AttributeName => ({ AttributeName, AttributeType: "S" })), KeySchema: [{ AttributeName: pk!, KeyType: "HASH" }, ...(sk ? [{ AttributeName: sk, KeyType: "RANGE" as const }] : [])] }));
    }
    token = signToken({ sub: legacyUser._id, email: legacyUser.email, role: "user" });
  }, 30000);
  afterAll(async () => {
    if (client) { for (const name of ["posts", "comments", "users", "series", "jobs"]) await client.send(new DeleteTableCommand({ TableName: `${prefix}-${name}` })); client.destroy(); }
  });
  it("logs in a legacy bcrypt user without changing role or leaking hashes; registration is unique", async () => {
    await getDocumentClient().send(new PutCommand({ TableName: process.env.USERS_TABLE, Item: { ...legacyUser, password: await hash("known-test-password", 4) } }));
    const result = await auth.login(event({ email: " EXAMPLE@example.com ", password: "known-test-password" }));
    expect(status(result)).toBe(200);
    expect(body(result).user).toEqual({ id: legacyUser._id, name: legacyUser.name, email: legacyUser.email, role: "user", createdAt: legacyUser.createdAt });
    expect(body(result).token).toBeTypeOf("string"); expect(body(result).user.password).toBeUndefined();
    expect(status(await auth.login(event({ email: legacyUser.email, password: "bad" })))).toBe(401);
    const payload = { name: "New", email: "new@example.com", password: "new-password" };
    const results = await Promise.all([auth.register(event(payload)), auth.register(event(payload))]);
    expect(results.map(status).sort()).toEqual([201, 409]);
  });
  it("preserves legacy post/section IDs, list envelopes, counters and no-upsert behavior", async () => {
    await getDocumentClient().send(new PutCommand({ TableName: process.env.POSTS_TABLE, Item: legacyPost }));
    const listed = body(await posts.list(event(undefined, {}, { status: "published", search: "A.B" })));
    expect(listed.items).toEqual([{ ...legacyPost, isSeries: false }]);
    expect(listed).toMatchObject({ total: 1, page: 1, limit: 10, expanded: false });
    const visited = body(await posts.get(event(undefined, { postId: legacyPost._id })));
    expect(visited.visited).toBe(6); expect(visited.content[0]._id).toBe(legacyPost.content[0]!._id);
    expect(visited._version).toBeUndefined();
    const missing = newId(); expect(status(await posts.get(event(undefined, { postId: missing })))).toBe(404);
    expect((await getDocumentClient().send(new GetCommand({ TableName: process.env.POSTS_TABLE, Key: { _id: missing } }))).Item).toBeUndefined();
    const increments = await Promise.all(Array.from({ length: 12 }, () => visitPost(legacyPost._id)));
    expect(Math.max(...increments.map(p => p.visited))).toBe(18);
  });
  it("creates, partially updates, changes status and deletes posts with the same auth boundaries", async () => {
    expect(status(await posts.create(event({ title: "New", postType: "books" })))).toBe(401);
    const result = await posts.create(event({ title: "New", postType: "books", searchBy: ["keep"], liked: 8, content: [{ content: "Synthetic Bengali বাংলা" }] }, {}, {}, true));
    expect(status(result)).toBe(201); const value = body(result);
    expect(value).toMatchObject({ status: "draft", summaryJobId: expect.any(String), grammerJobId: expect.any(String) });
    expect(value.content[0]._id).toMatch(/^[a-f\d]{24}$/);
    const changed = body(await posts.update(event({ gist: "Changed" }, { postId: value._id }, {}, true)));
    expect(changed.title).toBe("New"); expect(changed.gist).toBe("Changed"); expect(changed.summaryJobId).toBeUndefined();
    expect(changed.searchBy).toEqual(["keep"]); expect(changed.liked).toBe(8); expect(changed.content).toEqual(value.content);
    expect(body(await posts.updateStatus(event({ status: "published" }, { postId: value._id }, {}, true))).status).toBe("published");
    expect(body(await posts.remove(event(undefined, { postId: value._id }, {}, true)))).toEqual({ deleted: true, id: value._id });
    expect(status(await posts.update(event({ gist: "x" }, { postId: value._id }, {}, true)))).toBe(404);
  });
  it("protects concurrent post edits with version conditions", async () => {
    const value = await createPost({ title: "Concurrent", postType: "travel" });
    const results = await Promise.allSettled([updatePost(value._id, { gist: "one" }), updatePost(value._id, { gist: "two" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { statusCode: 409 } });
  });
  it("keeps comment CRUD scoped to the URL parent and leaves comments on post deletion", async () => {
    const parent = await createPost({ title: "Comments", postType: "books" });
    const created = await comments.create(event({ username: "Reader", title: "Title", description: "Comment" }, { postId: parent._id }));
    expect(status(created)).toBe(201); const value = body(created);
    const path = { postId: parent._id, commentId: value._id };
    expect(body(await comments.list(event(undefined, { postId: parent._id }))).items).toEqual([value]);
    expect(status(await comments.get(event(undefined, { postId: newId(), commentId: value._id })))).toBe(404);
    expect(body(await comments.update(event({ title: "Edited" }, path))).title).toBe("Edited");
    expect(status(await comments.reply(event({ reply: "Thanks" }, path)))).toBe(401);
    expect(body(await comments.reply(event({ reply: "Thanks" }, path, {}, true))).reply).toBe("Thanks");
    await posts.remove(event(undefined, { postId: parent._id }, {}, true));
    expect(status(await comments.get(event(undefined, path)))).toBe(200);
    expect(status(await comments.remove(event(undefined, path)))).toBe(200);
  });
  it("reserves series parts atomically, hydrates posts and releases memberships", async () => {
    const result = await series.create(event({ title: "Walking diaries" }, {}, {}, true)); const s = body(result);
    expect(s.memberCount).toBeUndefined(); expect(s.recordKey).toBeUndefined();
    const results = await Promise.all([1, 2].map(() => posts.create(event({ title: "Part", postType: "travel", series: { seriesId: s._id, part: 1 } }, {}, {}, true))));
    expect(results.map(status).sort()).toEqual([201, 409]);
    const first = body(results.find(r => status(r) === 201));
    const second = body(await posts.create(event({ title: "Part two", postType: "travel", series: { seriesId: s._id, part: 2 } }, {}, {}, true)));
    expect(status(await series.remove(event(undefined, { seriesId: s._id }, {}, true)))).toBe(409);
    expect(body(await series.get(event(undefined, { seriesId: s._id }))).totalParts).toBe(2);
    const list = body(await posts.list(event(undefined, {}, { search: "", expanded: "false" })));
    expect(list.items.some((p: any) => p._id === second._id)).toBe(false);
    const expanded = body(await posts.list(event(undefined, {}, { expanded: "true" })));
    expect(expanded.items.find((p: any) => p._id === first._id).series.posts).toHaveLength(2);
    expect(body(await series.list(event(undefined, {}, { search: "walk" }))).items).toHaveLength(1);
    await posts.update(event({ series: { seriesId: s._id, part: 3 } }, { postId: second._id }, {}, true));
    await posts.remove(event(undefined, { postId: first._id }, {}, true)); await posts.remove(event(undefined, { postId: second._id }, {}, true));
    expect(status(await series.remove(event(undefined, { seriesId: s._id }, {}, true)))).toBe(200);
  });
  it("keeps upload filenames and section targeting with direct and presigned uploads", async () => {
    const value = await createPost({ title: "Upload", postType: "travel", content: [{ header: "One" }] });
    const direct = body(await uploads.hero(event({ fileName: "hero.jpg", contentType: "image/jpeg", dataBase64: "eA==" }, { postId: value._id }, {}, true)));
    expect(direct.post.photoHero).toBe(`photo_${value._id}.jpg`);
    const sectionId = value.content[0]!._id;
    const presigned = body(await uploads.section(event({ fileName: "image.png", contentType: "image/png" }, { postId: value._id, sectionId }, {}, true)));
    expect(presigned.uploadUrl).toBe("https://example.com/presigned"); expect(presigned.post.content[0].image).toBe(`photo_${value._id}-${sectionId}.png`);
    expect(status(await uploads.section(event({ fileName: "x.jpg", contentType: "image/jpeg" }, { postId: value._id, sectionId: newId() }, {}, true)))).toBe(404);
  });
  it("runs summary/grammar jobs once and keeps poll response aliases", async () => {
    mocks.completion.mockResolvedValue({ choices: [{ message: { content: "Synthetic summary" } }] });
    const created = await createSummary(event({ content: "Synthetic content" }, {}, {}, true));
    expect(status(created)).toBe(202); const id = body(created).jobId;
    await Promise.all([grammar.processBackgroundJob({ jobId: id }), grammar.processBackgroundJob({ jobId: id })]);
    expect(mocks.completion).toHaveBeenCalledTimes(1);
    const polled = body(await grammar.getWorkerByJobId(event(undefined, { jobId: id }, {}, true)));
    expect(polled).toMatchObject({ workId: id, jobId: id, status: "completed", result: { summary: "Synthetic summary" }, error: null });
    await grammar.processBackgroundJob({ jobId: id }); expect(mocks.completion).toHaveBeenCalledTimes(1);
    mocks.completion.mockResolvedValue({ choices: [{ message: { content: '{"suggestions":[null]}' } }] });
    const checked = await grammar.createGrammerCheck(event({ sections: [{ id: "s1", text: "গল্প" }] }, {}, {}, true));
    const gid = body(checked).jobId; await grammar.processBackgroundJob({ jobId: gid });
    expect(body(await grammar.getGrammerCheck(event(undefined, { jobId: gid }, {}, true)))).toMatchObject({ workId: gid, status: "completed", result: [null] });
    const failed = await createJob("summary", { content: "Synthetic content" }); delete process.env.OPENAI_API_KEY;
    await grammar.processBackgroundJob({ jobId: failed._id }); expect((await findJob(failed._id))?.status).toBe("failed"); process.env.OPENAI_API_KEY = "synthetic-key";
    expect(status(await grammar.getWorkerByJobId(event(undefined, { jobId: id })))).toBe(401);
  });
  it("traverses real 1 MB scan/query boundaries without leaking storage metadata", async () => {
    const payload = "x".repeat(60000), parent = newId();
    for (let index = 0; index < 20; index++) {
      await getDocumentClient().send(new PutCommand({ TableName: process.env.POSTS_TABLE, Item: { ...legacyPost, _id: newId(), title: "Large", content: [{ ...legacyPost.content[0], content: payload }] } }));
      await getDocumentClient().send(new PutCommand({ TableName: process.env.COMMENTS_TABLE, Item: { post: parent, _id: newId(), description: payload } }));
    }
    const firstPage = await getDocumentClient().send(new ScanCommand({ TableName: process.env.POSTS_TABLE })); expect(firstPage.LastEvaluatedKey).toBeDefined();
    expect((await scanItems("POSTS")).length).toBeGreaterThan(20);
    expect(await queryItems({ TableName: process.env.COMMENTS_TABLE!, KeyConditionExpression: "post = :post", ExpressionAttributeValues: { ":post": parent } })).toHaveLength(20);
  });
});
