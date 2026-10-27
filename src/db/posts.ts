import { GetCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, table, publicItem, scanItems, conditional, type Item } from "./dynamodb.js";
import type { Post, Series } from "./entities.js";
import { newId, assertObjectId } from "../utils/ids.js";
import { HttpError } from "../utils/http.js";
import { createPostSchema } from "../validation/post.js";

export const allPosts = () => scanItems<Post>("POSTS");
async function storedPost(id: string): Promise<(Post & { _version?: number }) | undefined> {
  const result = await getDocumentClient().send(new GetCommand({ TableName: table("POSTS"), Key: { _id: id }, ConsistentRead: true }));
  return result.Item as (Post & { _version?: number }) | undefined;
}
export async function findPost(id: string): Promise<Post | undefined> { const value = await storedPost(id); return value ? publicItem<Post>(value) : undefined; }
export function postFields(payload: Item): Item {
  const { summary, aiRequired, aiSummaryJobId, aiGrammerJobId, ...fields } = payload;
  if (fields.content) fields.content = fields.content.map((section: Item) => ({ ...section, _id: section._id ?? newId() }));
  if (fields.series) fields.series = { ...fields.series, seriesId: assertObjectId(fields.series.seriesId, "seriesId") };
  return fields;
}
type Actions = NonNullable<TransactWriteCommandInput["TransactItems"]>;
async function savePost(old: (Post & { _version?: number }) | undefined, next: Post | undefined): Promise<void> {
  const id = next?._id ?? old!._id;
  const actions: Actions = [];
  const condition = old ? (old._version === undefined ? "attribute_exists(#id) AND attribute_not_exists(#v)" : "#v = :version") : "attribute_not_exists(#id)";
  const names: Record<string, string> = old ? { "#id": "_id", "#v": "_version" } : { "#id": "_id" };
  // DynamoDB rejects unused expression aliases.
  if (old?._version !== undefined) delete (names as Item)["#id"];
  const guarded = { TableName: table("POSTS"), ConditionExpression: condition, ExpressionAttributeNames: names, ...(old?._version !== undefined ? { ExpressionAttributeValues: { ":version": old._version } } : {}) };
  actions.push(next ? { Put: { ...guarded, Item: { ...next, _version: (old?._version ?? 0) + 1 } } } : { Delete: { ...guarded, Key: { _id: id } } });
  const before = old?.series, after = next?.series;
  const changed = before?.seriesId !== after?.seriesId || before?.part !== after?.part;
  if (changed) {
    if (before) actions.push({ Delete: { TableName: table("SERIES"), Key: { seriesId: before.seriesId, recordKey: `PART#${before.part}` }, ConditionExpression: "postId = :post", ExpressionAttributeValues: { ":post": id } } });
    if (after) actions.push({ Put: { TableName: table("SERIES"), Item: { seriesId: after.seriesId, recordKey: `PART#${after.part}`, postId: id }, ConditionExpression: "attribute_not_exists(seriesId)" } });
    for (const seriesId of new Set([before?.seriesId, after?.seriesId].filter((x): x is string => Boolean(x)))) {
      const delta = Number(after?.seriesId === seriesId) - Number(before?.seriesId === seriesId);
      actions.push({ Update: { TableName: table("SERIES"), Key: { seriesId, recordKey: "META" }, UpdateExpression: "ADD memberCount :delta", ConditionExpression: `attribute_exists(seriesId)${delta < 0 ? " AND memberCount >= :one" : ""}`, ExpressionAttributeValues: { ":delta": delta, ...(delta < 0 ? { ":one": 1 } : {}) } } });
    }
  }
  try { await getDocumentClient().send(new TransactWriteCommand({ TransactItems: actions })); }
  catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      const reasons = (error as Error & { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
      if (reasons?.some(r => r.Code && !["None", "ConditionalCheckFailed", "TransactionConflict"].includes(r.Code))) throw error;
      if (after) {
        const result = await getDocumentClient().send(new GetCommand({ TableName: table("SERIES"), Key: { seriesId: after.seriesId, recordKey: "META" }, ConsistentRead: true }));
        if (!result.Item) throw new HttpError(404, "Series not found.");
      }
      throw new HttpError(409, "Post changed concurrently or series part is already used by another post.");
    }
    throw error;
  }
}
export async function createPost(payload: Item): Promise<Post> {
  const next = { ...postFields(createPostSchema.parse(payload)), _id: newId(), createdAt: new Date().toISOString() } as Post;
  await savePost(undefined, next); return next;
}
export async function updatePost(id: string, payload: Item): Promise<Post> {
  const old = await storedPost(id);
  if (!old) throw new HttpError(404, "Post not found.");
  const next = { ...publicItem<Post>(old), ...postFields(payload) } as Post;
  await savePost(old, next); return next;
}
export async function deletePost(id: string): Promise<void> {
  const old = await storedPost(id);
  if (!old) throw new HttpError(404, "Post not found.");
  await savePost(old, undefined);
}
export async function visitPost(id: string): Promise<Post> {
  try {
    const result = await getDocumentClient().send(new UpdateCommand({ TableName: table("POSTS"), Key: { _id: id }, UpdateExpression: "SET visited = if_not_exists(visited, :zero) + :one, #v = if_not_exists(#v, :zero) + :one", ConditionExpression: "attribute_exists(#id)", ExpressionAttributeNames: { "#id": "_id", "#v": "_version" }, ExpressionAttributeValues: { ":zero": 0, ":one": 1 }, ReturnValues: "ALL_NEW" }));
    return publicItem<Post>(result.Attributes!);
  } catch (error) { if (conditional(error)) throw new HttpError(404, "Post not found."); throw error; }
}
export async function updateSectionImage(id: string, sectionId: string, image: string): Promise<Post> {
  const old = await storedPost(id);
  if (!old || !old.content.some(section => section._id === sectionId)) throw new HttpError(404, "Post or section not found.");
  const next = { ...publicItem<Post>(old), content: old.content.map(section => section._id === sectionId ? { ...section, image } : section) };
  await savePost(old, next); return next;
}
export function sortRecords<T extends { _id: string }>(items: T[], field: keyof T, ascending: boolean): T[] {
  return items.sort((a, b) => {
    const x = a[field] ?? "", y = b[field] ?? "";
    const compare = typeof x === "string" && typeof y === "string" ? Buffer.compare(Buffer.from(x), Buffer.from(y)) : x < y ? -1 : x > y ? 1 : 0;
    return (ascending ? compare : -compare) || a._id.localeCompare(b._id);
  });
}
export async function hydrateSeries(posts: Post[]): Promise<Array<Post & { isSeries: boolean }>> {
  if (!posts.some(post => post.series)) return posts.map(post => ({ ...post, isSeries: false }));
  const [series, related] = await Promise.all([scanItems<Series>("SERIES"), allPosts()]);
  return posts.map(post => {
    if (!post.series) return { ...post, isSeries: false };
    const group = related.filter(p => p.series?.seriesId === post.series!.seriesId).sort((a, b) => a.series!.part - b.series!.part).map(p => ({ postId: p._id, title: p.title, part: p.series!.part }));
    return { ...post, isSeries: true, series: { ...post.series, title: series.find(s => s._id === post.series!.seriesId)?.title ?? "", totalParts: group.length, posts: group } };
  });
}
