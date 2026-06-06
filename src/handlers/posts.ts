import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { SortOrder } from "mongoose";
import { connectToDatabase } from "../db/mongo.js";
import { PostModel } from "../models/post.js";
import { requireAuth } from "../utils/auth.js";
import { assertObjectId } from "../utils/ids.js";
import { handle, HttpError, json, parseJsonBody, pathParam, queryNumber } from "../utils/http.js";
import { createPostSchema, updatePostSchema } from "../validation/post.js";

const allowedSort = new Set(["createdAt", "title", "visited", "liked"]);

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    await connectToDatabase();
    const page = queryNumber(event.queryStringParameters?.page, 1, 1, 100000);
    const limit = queryNumber(event.queryStringParameters?.limit, 10, 1, 50);
    const search = event.queryStringParameters?.search?.trim();
    const sortBy = event.queryStringParameters?.sortBy ?? "createdAt";
    const sortOrder: SortOrder = event.queryStringParameters?.sortOrder === "asc" ? 1 : -1;
    const filter = search
      ? { $text: { $search: search } }
      : {};
    const sort: Record<string, SortOrder> = { [allowedSort.has(sortBy) ? sortBy : "createdAt"]: sortOrder };
    const [items, total] = await Promise.all([
      PostModel.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      PostModel.countDocuments(filter)
    ]);

    return json(200, {
      items,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    });
  });
}

export async function get(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    await connectToDatabase();
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const post = await PostModel.findByIdAndUpdate(postId, { $inc: { visited: 1 } }, { new: true }).lean();

    if (!post) {
      throw new HttpError(404, "Post not found.");
    }

    return json(200, post);
  });
}

export async function create(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const body = parseJsonBody(event, createPostSchema);
    const post = await PostModel.create(body);

    return json(201, post.toObject());
  });
}

export async function update(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const body = parseJsonBody(event, updatePostSchema);
    const post = await PostModel.findByIdAndUpdate(postId, body, { new: true, runValidators: true }).lean();

    if (!post) {
      throw new HttpError(404, "Post not found.");
    }

    return json(200, post);
  });
}

export async function remove(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const post = await PostModel.findByIdAndDelete(postId).lean();

    if (!post) {
      throw new HttpError(404, "Post not found.");
    }

    return json(200, { deleted: true, id: postId });
  });
}
