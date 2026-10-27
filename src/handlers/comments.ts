import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getItem, putItem, updateItem, deleteItem, queryItems, table } from "../db/dynamodb.js";
import { findPost } from "../db/posts.js";
import type { Comment } from "../db/entities.js";
import { newId } from "../utils/ids.js";
import { assertObjectId } from "../utils/ids.js";
import { handle, HttpError, json, parseJsonBody, pathParam } from "../utils/http.js";
import { createCommentSchema, replyCommentSchema, updateCommentSchema } from "../validation/comment.js";
import { requireAuth } from "../utils/auth.js";

async function ensurePost(postId: string): Promise<void> {
  const exists = await findPost(postId);
  if (!exists) {
    throw new HttpError(404, "Post not found.");
  }
}

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    await ensurePost(postId);
    const comments = (await queryItems<Comment>({ TableName: table("COMMENTS"), KeyConditionExpression: "post = :post", ExpressionAttributeValues: { ":post": postId } })).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a._id.localeCompare(b._id));

    return json(200, { items: comments });
  });
}

export async function get(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const commentId = assertObjectId(pathParam(event, "commentId"), "commentId");
    const comment = await getItem<Comment>("COMMENTS", { post: postId, _id: commentId });

    if (!comment) {
      throw new HttpError(404, "Comment not found.");
    }

    return json(200, comment);
  });
}

export async function create(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    await ensurePost(postId);
    const body = parseJsonBody(event, createCommentSchema);
    const comment = await putItem<Comment>("COMMENTS", { ...body, post: postId, _id: newId(), createdAt: new Date().toISOString() });

    return json(201, comment);
  });
}

export async function update(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const commentId = assertObjectId(pathParam(event, "commentId"), "commentId");
    const body = parseJsonBody(event, updateCommentSchema);
    const comment = await changeComment(postId, commentId, body);

    if (!comment) {
      throw new HttpError(404, "Comment not found.");
    }

    return json(200, comment);
  });
}

export async function reply(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const commentId = assertObjectId(pathParam(event, "commentId"), "commentId");
    const body = parseJsonBody(event, replyCommentSchema);
    const comment = await changeComment(postId, commentId, { reply: body.reply });

    if (!comment) {
      throw new HttpError(404, "Comment not found.");
    }

    return json(200, comment);
  });
}

export async function remove(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const commentId = assertObjectId(pathParam(event, "commentId"), "commentId");
    await requireComment(postId, commentId);
    await deleteItem("COMMENTS", { post: postId, _id: commentId });


    return json(200, { deleted: true, id: commentId });
  });
}

async function requireComment(post: string, _id: string) { const value = await getItem<Comment>("COMMENTS", { post, _id }); if (!value) throw new HttpError(404, "Comment not found."); return value; }
async function changeComment(post: string, _id: string, values: Record<string, unknown>) { await requireComment(post, _id); try { return await updateItem<Comment>("COMMENTS", { post, _id }, values); } catch (error) { if (error instanceof HttpError && error.statusCode === 404) throw new HttpError(404, "Comment not found."); throw error; } }
