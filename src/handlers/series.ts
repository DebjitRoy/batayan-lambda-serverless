import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { SortOrder } from "mongoose";
import { connectToDatabase } from "../db/mongo.js";
import { PostModel } from "../models/post.js";
import { SeriesModel } from "../models/series.js";
import { requireAuth } from "../utils/auth.js";
import { assertObjectId } from "../utils/ids.js";
import { handle, HttpError, json, parseJsonBody, pathParam, queryNumber } from "../utils/http.js";
import { createSeriesSchema, updateSeriesSchema } from "../validation/series.js";

const allowedSort = new Set(["createdAt", "title"]);

type SeriesResponse = Record<string, unknown> & {
  _id?: unknown;
};

type SeriesPostResponse = Record<string, unknown> & {
  _id?: unknown;
  title?: string;
  series?: { part?: number };
};

async function withPostSummary(seriesItems: SeriesResponse[]): Promise<Array<SeriesResponse & { totalParts: number; posts: Array<{ postId: string; title: string; part: number }> }>> {
  const seriesIds = seriesItems.map((series) => String(series._id));
  const posts = await PostModel.find({ "series.seriesId": { $in: seriesIds } })
    .select("_id title series")
    .sort({ "series.part": 1 })
    .lean();
  const postsBySeriesId = new Map<string, Array<{ postId: string; title: string; part: number }>>();

  for (const post of posts as SeriesPostResponse[]) {
    const seriesId = String((post.series as { seriesId?: string } | undefined)?.seriesId ?? "");
    const part = post.series?.part;
    if (!seriesId || !part) continue;

    const group = postsBySeriesId.get(seriesId) ?? [];
    group.push({ postId: String(post._id), title: post.title ?? "", part });
    postsBySeriesId.set(seriesId, group);
  }

  return seriesItems.map((series) => {
    const postsForSeries = postsBySeriesId.get(String(series._id)) ?? [];
    return {
      ...series,
      totalParts: postsForSeries.length,
      posts: postsForSeries
    };
  });
}

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    await connectToDatabase();
    const page = queryNumber(event.queryStringParameters?.page, 1, 1, 100000);
    const limit = queryNumber(event.queryStringParameters?.limit, 10, 1, 50);
    const search = event.queryStringParameters?.search?.trim();
    const sortBy = event.queryStringParameters?.sortBy ?? "createdAt";
    const sortOrder: SortOrder = event.queryStringParameters?.sortOrder === "asc" ? 1 : -1;
    const filter = search ? { $text: { $search: search } } : {};
    const sort: Record<string, SortOrder> = { [allowedSort.has(sortBy) ? sortBy : "createdAt"]: sortOrder };
    const [items, total] = await Promise.all([
      SeriesModel.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      SeriesModel.countDocuments(filter)
    ]);

    return json(200, {
      items: await withPostSummary(items as SeriesResponse[]),
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
    const seriesId = assertObjectId(pathParam(event, "seriesId"), "seriesId");
    const series = await SeriesModel.findById(seriesId).lean();

    if (!series) {
      throw new HttpError(404, "Series not found.");
    }

    const [seriesWithPosts] = await withPostSummary([series as SeriesResponse]);
    return json(200, seriesWithPosts ?? series);
  });
}

export async function create(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const body = parseJsonBody(event, createSeriesSchema);
    const series = await SeriesModel.create(body);

    return json(201, { ...series.toObject(), totalParts: 0, posts: [] });
  });
}

export async function update(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const seriesId = assertObjectId(pathParam(event, "seriesId"), "seriesId");
    const body = parseJsonBody(event, updateSeriesSchema);
    const series = await SeriesModel.findByIdAndUpdate(seriesId, body, { new: true, runValidators: true }).lean();

    if (!series) {
      throw new HttpError(404, "Series not found.");
    }

    const [seriesWithPosts] = await withPostSummary([series as SeriesResponse]);
    return json(200, seriesWithPosts ?? series);
  });
}

export async function remove(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const seriesId = assertObjectId(pathParam(event, "seriesId"), "seriesId");
    const postCount = await PostModel.countDocuments({ "series.seriesId": seriesId });

    if (postCount > 0) {
      throw new HttpError(409, "Series has posts and cannot be deleted.");
    }

    const series = await SeriesModel.findByIdAndDelete(seriesId).lean();

    if (!series) {
      throw new HttpError(404, "Series not found.");
    }

    return json(200, { deleted: true, id: seriesId });
  });
}
