import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { connectToDatabase } from "../db/mongo.js";
import { CommentModel } from "../models/comment.js";
import { PostModel } from "../models/post.js";
import { assertObjectId } from "../utils/ids.js";
import { handle, HttpError, json, parseJsonBody, pathParam } from "../utils/http.js";
import { createCommentSchema, replyCommentSchema, updateCommentSchema } from "../validation/comment.js";
import { requireAuth } from "../utils/auth.js";

async function ensurePost(postId: string): Promise<void> {
  const exists = await PostModel.exists({ _id: postId });
  if (!exists) {
    throw new HttpError(404, "Post not found.");
  }
}

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    await connectToDatabase();
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    await ensurePost(postId);
    const comments = await CommentModel.find({ post: postId }).sort({ createdAt: -1 }).lean();

    return json(200, { items: comments });
  });
}

export async function get(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    await connectToDatabase();
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const commentId = assertObjectId(pathParam(event, "commentId"), "commentId");
    const comment = await CommentModel.findOne({ _id: commentId, post: postId }).lean();

    if (!comment) {
      throw new HttpError(404, "Comment not found.");
    }

    return json(200, comment);
  });
}

export async function create(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    await connectToDatabase();
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    await ensurePost(postId);
    const body = parseJsonBody(event, createCommentSchema);
    const comment = await CommentModel.create({ ...body, post: postId });

    return json(201, comment.toObject());
  });
}

export async function update(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    await connectToDatabase();
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const commentId = assertObjectId(pathParam(event, "commentId"), "commentId");
    const body = parseJsonBody(event, updateCommentSchema);
    const comment = await CommentModel.findOneAndUpdate({ _id: commentId, post: postId }, body, {
      new: true,
      runValidators: true
    }).lean();

    if (!comment) {
      throw new HttpError(404, "Comment not found.");
    }

    return json(200, comment);
  });
}

export async function reply(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const commentId = assertObjectId(pathParam(event, "commentId"), "commentId");
    const body = parseJsonBody(event, replyCommentSchema);
    const comment = await CommentModel.findOneAndUpdate(
      { _id: commentId, post: postId },
      { reply: body.reply },
      { new: true, runValidators: true }
    ).lean();

    if (!comment) {
      throw new HttpError(404, "Comment not found.");
    }

    return json(200, comment);
  });
}

export async function remove(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    await connectToDatabase();
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const commentId = assertObjectId(pathParam(event, "commentId"), "commentId");
    const comment = await CommentModel.findOneAndDelete({ _id: commentId, post: postId }).lean();

    if (!comment) {
      throw new HttpError(404, "Comment not found.");
    }

    return json(200, { deleted: true, id: commentId });
  });
}
