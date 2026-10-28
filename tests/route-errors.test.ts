import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import * as posts from "../src/handlers/posts.js";
import * as series from "../src/handlers/series.js";
import * as comments from "../src/handlers/comments.js";
import * as uploads from "../src/handlers/uploads.js";
import * as grammar from "../src/handlers/grammerCheck.js";
import * as auth from "../src/handlers/auth.js";
import { createSummary } from "../src/handlers/summary.js";
const event = (body = "{}"): APIGatewayProxyEventV2 => ({
  version: "2.0", routeKey: "", rawPath: "", rawQueryString: "",
  requestContext: {} as APIGatewayProxyEventV2["requestContext"],
  headers: {}, isBase64Encoded: false, body,
  pathParameters: { postId: "invalid", seriesId: "invalid", commentId: "invalid", sectionId: "invalid", jobId: "invalid" }
});
const body = (result: unknown) => JSON.parse((result as { body: string }).body);
describe("protected route authentication contracts", () => {
  it.each([
    ["post create", posts.create], ["post update", posts.update], ["post status", posts.updateStatus], ["post delete", posts.remove],
    ["series create", series.create], ["series update", series.update], ["series delete", series.remove],
    ["hero upload", uploads.hero], ["section upload", uploads.section], ["comment reply", comments.reply],
    ["summary create", createSummary], ["grammar create", grammar.createGrammerCheck], ["grammar poll", grammar.getGrammerCheck], ["worker poll", grammar.getWorkerByJobId]
  ] as const)("%s rejects missing bearer authentication before side effects", async (_, handler) => {
    const result = await handler(event());
    expect(result).toMatchObject({ statusCode: 401 });
    expect(body(result)).toEqual({ error: "Bearer token is required.", details: null });
  });
});
describe("public route validation contracts", () => {
  it.each([
    ["post get", posts.get], ["series get", series.get], ["comment list", comments.list], ["comment get", comments.get],
    ["comment create", comments.create], ["comment update", comments.update], ["comment delete", comments.remove]
  ] as const)("%s rejects malformed IDs before database access", async (_, handler) => {
    const result = await handler(event());
    expect(result).toMatchObject({ statusCode: 400 }); expect(body(result).error).toMatch(/^Invalid /);
  });
  it.each([["register", auth.register], ["login", auth.login]] as const)("%s reports malformed JSON without echoing input", async (_, handler) => {
    const result = await handler(event('{"password":"private-test-value"'));
    expect(result).toMatchObject({ statusCode: 400 });
    expect(body(result)).toEqual({ error: "Request body must be valid JSON.", details: null });
    expect(JSON.stringify(result)).not.toContain("private-test-value");
  });
});
