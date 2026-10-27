import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { post, comment } from "./fixtures/legacy.js";
const mocks = vi.hoisted(() => ({ all: vi.fn(), find: vi.fn(), comments: vi.fn() }));
vi.mock("../src/db/posts.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/db/posts.js")>(), allPosts: mocks.all, findPost: mocks.find }));
vi.mock("../src/db/dynamodb.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/db/dynamodb.js")>(), queryItems: mocks.comments, table: () => "comments" }));
import { list } from "../src/handlers/posts.js";
import { list as listComments } from "../src/handlers/comments.js";
import { matchesSeriesSearch } from "../src/utils/text-search.js";
import { newId, assertObjectId } from "../src/utils/ids.js";
const event = (extra = {}) => ({ headers: {}, isBase64Encoded: false, ...extra }) as APIGatewayProxyEventV2;
const body = (result: unknown) => JSON.parse((result as { body: string }).body);
describe("contracts characterized before replacing MongoDB", () => {
  beforeEach(() => vi.clearAllMocks());
  it("returns the same historical post envelope and literal tag search", async () => {
    mocks.all.mockResolvedValue([post, { ...post, _id: newId(), searchBy: ["axb"] }]);
    const result = await list(event({ queryStringParameters: { status: "published", search: "A.B" } }));
    expect(body(result)).toEqual({ items: [{ ...post, isSeries: false }], page: 1, limit: 10, total: 1, totalPages: 1, expanded: false });
  });
  it("filters before sorting/slicing and computes exact totals", async () => {
    mocks.all.mockResolvedValue([post, { ...post, _id: newId(), visited: 100 }, { ...post, _id: newId(), status: "draft" }]);
    const result = body(await list(event({ queryStringParameters: { status: "published", sortBy: "visited", page: "2", limit: "1" } })));
    expect(result).toMatchObject({ total: 2, totalPages: 2, page: 2, limit: 1, items: [expect.objectContaining({ visited: 5 })] });
  });
  it("keeps comments in the same envelope and checks the parent", async () => {
    mocks.find.mockResolvedValue(post); mocks.comments.mockResolvedValue([comment]);
    expect(body(await listComments(event({ pathParameters: { postId: post._id } })))).toEqual({ items: [comment] });
    mocks.find.mockResolvedValue(undefined);
    expect(body(await listComments(event({ pathParameters: { postId: post._id } })))).toEqual({ error: "Post not found.", details: null });
  });
  it("retains ObjectId-compatible identifiers", () => {
    expect(assertObjectId(post._id.toUpperCase())).toBe(post._id);
    expect(newId()).toMatch(/^[a-f\d]{24}$/);
    expect(() => assertObjectId("invalid")).toThrow("Invalid id.");
  });
});
describe("series text search", () => {
  const fields = ["Walking through cafés", "A book about Kolkata", "কলকাতা ভ্রমণ"];
  it("uses whole tokens, English stemming, diacritics and OR terms", () => {
    expect(matchesSeriesSearch(fields, "walk")).toBe(true);
    expect(matchesSeriesSearch(fields, "cafe")).toBe(true);
    expect(matchesSeriesSearch(fields, "missing books")).toBe(true);
    expect(matchesSeriesSearch(fields, "kol")).toBe(false);
    expect(matchesSeriesSearch(fields, "the")).toBe(false);
    expect(matchesSeriesSearch(fields, "কলকাতা")).toBe(true);
  });
  it("requires phrases and honors exclusions", () => {
    expect(matchesSeriesSearch(fields, '"A book"')).toBe(true);
    expect(matchesSeriesSearch(fields, 'book -kolkata')).toBe(false);
    expect(matchesSeriesSearch(fields, 'book "missing phrase"')).toBe(false);
    expect(matchesSeriesSearch(fields, '-book')).toBe(false);
  });
});
