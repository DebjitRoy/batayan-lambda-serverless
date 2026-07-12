import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { SortOrder } from "mongoose";
import { connectToDatabase } from "../db/mongo.js";
import { PostModel } from "../models/post.js";
import { SeriesModel } from "../models/series.js";
import { requireAuth } from "../utils/auth.js";
import { assertObjectId } from "../utils/ids.js";
import { handle, HttpError, json, parseJsonBody, pathParam, queryNumber } from "../utils/http.js";
import { createGrammerCheckJob as createGrammerCheckJobHandler } from "./grammerCheck.js";
import { createSummaryJob as createSummaryJobHandler } from "./summary.js";
import { createPostSchema, updatePostSchema, updatePostStatusSchema } from "../validation/post.js";

const allowedSort = new Set(["createdAt", "title", "visited", "liked"]);

type PostResponse = Record<string, unknown> & {
  _id?: unknown;
  title?: string;
  series?: { seriesId?: string; part?: number } | null;
};

type PostListFilter = Record<string, unknown>;
type PostContentSection = {
  id?: string | null;
  _id?: unknown;
  header?: string | null;
  content?: string | null;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listFilter(search: string | undefined, expanded: boolean, status?: string): PostListFilter {
  const filters: PostListFilter[] = [];

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filters.push({ searchBy: regex });
  }

  if (!expanded) {
    filters.push({
      $or: [
        { series: { $exists: false } },
        { series: null },
        { "series.seriesId": { $exists: false } },
        { "series.part": 1 }
      ]
    });
  }

  if (status) {
    if (status === "published") {
      filters.push({ $or: [{ status: "published" }, { status: { $exists: false } }] });
    } else if (status === "draft" || status === "archived") {
      filters.push({ status });
    }
  }

  if (filters.length === 0) return {};
  if (filters.length === 1) return filters[0] ?? {};
  return { $and: filters };
}

async function hydrateSeries(posts: PostResponse[]): Promise<Array<PostResponse & { isSeries: boolean }>> {
  const seriesIds = [...new Set(posts.map((post) => post.series?.seriesId).filter((seriesId): seriesId is string => Boolean(seriesId)))];

  if (seriesIds.length === 0) {
    return posts.map((post) => ({ ...post, isSeries: false }));
  }

  const [seriesDocuments, seriesPosts] = await Promise.all([
    SeriesModel.find({ _id: { $in: seriesIds } }).lean(),
    PostModel.find({ "series.seriesId": { $in: seriesIds } })
      .select("_id title series")
      .sort({ "series.part": 1 })
      .lean()
  ]);
  const seriesById = new Map(seriesDocuments.map((series) => [String(series._id), series]));
  const postsBySeriesId = new Map<string, Array<{ postId: string; title: string; part: number }>>();

  for (const relatedPost of seriesPosts as PostResponse[]) {
    const seriesId = relatedPost.series?.seriesId;
    const part = relatedPost.series?.part;
    if (!seriesId || !part) continue;

    const postsForSeries = postsBySeriesId.get(seriesId) ?? [];
    postsForSeries.push({
      postId: String(relatedPost._id),
      title: relatedPost.title ?? "",
      part
    });
    postsBySeriesId.set(seriesId, postsForSeries);
  }

  return posts.map((post) => {
    const seriesId = post.series?.seriesId;

    if (!seriesId) {
      return { ...post, isSeries: false };
    }

    const series = seriesById.get(seriesId);
    const relatedPosts = postsBySeriesId.get(seriesId) ?? [];

    return {
      ...post,
      isSeries: true,
      series: {
        seriesId,
        title: series?.title ?? "",
        part: post.series?.part ?? 1,
        totalParts: relatedPosts.length,
        posts: relatedPosts
      }
    };
  });
}

function buildSummaryContent(content: PostContentSection[] | undefined): string {
  return (content ?? [])
    .map((section) => {
      const parts = [section.header, section.content]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
      return parts.join("\n");
    })
    .filter((segment) => segment.trim().length > 0)
    .join("\n\n");
}

function buildGrammarSections(content: PostContentSection[] | undefined): Array<{ id: string; text: string }> {
  return (content ?? [])
    .map((section, index) => {
      const text = [section.header, section.content]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join("\n");

      if (!text.trim()) {
        return null;
      }

      const sectionId = typeof section.id === "string" && section.id.trim().length > 0
        ? section.id
        : typeof section._id !== "undefined" && section._id !== null
          ? String(section._id)
          : `section-${index + 1}`;

      return {
        id: sectionId,
        text
      };
    })
    .filter((section): section is { id: string; text: string } => Boolean(section));
}

export async function maybeCreatePostJobs({
  content,
  summary,
  createSummaryJob = createSummaryJobHandler,
  createGrammerCheckJob = createGrammerCheckJobHandler
}: {
  content?: PostContentSection[];
  summary?: string;
  createSummaryJob?: typeof createSummaryJobHandler;
  createGrammerCheckJob?: typeof createGrammerCheckJobHandler;
}): Promise<{ summaryJobId: string | null; grammerJobId: string | null }> {
  const hasSummary = typeof summary === "string" && summary.trim().length > 0;
  const summaryContent = buildSummaryContent(content);
  const grammarSections = buildGrammarSections(content);

  const [summaryJobResult, grammarJobResult] = await Promise.allSettled([
    hasSummary || !summaryContent.trim()
      ? Promise.resolve(null)
      : createSummaryJob(summaryContent),
    grammarSections.length === 0
      ? Promise.resolve(null)
      : createGrammerCheckJob(grammarSections)
  ]);

  return {
    summaryJobId: summaryJobResult.status === "fulfilled" ? summaryJobResult.value?.jobId ?? null : null,
    grammerJobId: grammarJobResult.status === "fulfilled" ? grammarJobResult.value?.jobId ?? null : null
  };
}

async function ensureSeriesPart(series: { seriesId: string; part: number } | undefined, postId?: string): Promise<void> {
  if (!series) return;

  const seriesId = assertObjectId(series.seriesId, "seriesId");
  const exists = await SeriesModel.exists({ _id: seriesId });
  if (!exists) {
    throw new HttpError(404, "Series not found.");
  }

  const duplicateFilter: PostListFilter = {
    "series.seriesId": seriesId,
    "series.part": series.part
  };

  if (postId) {
    duplicateFilter._id = { $ne: postId };
  }

  const duplicate = await PostModel.exists(duplicateFilter);
  if (duplicate) {
    throw new HttpError(409, "Series part is already used by another post.");
  }
}

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    await connectToDatabase();
    const page = queryNumber(event.queryStringParameters?.page, 1, 1, 100000);
    const limit = queryNumber(event.queryStringParameters?.limit, 10, 1, 50);
    const search = event.queryStringParameters?.search?.trim();
    const expanded = event.queryStringParameters?.expanded === "true";
    const status = event.queryStringParameters?.status?.trim();
    const sortBy = event.queryStringParameters?.sortBy ?? "createdAt";
    const sortOrder: SortOrder = event.queryStringParameters?.sortOrder === "asc" ? 1 : -1;
    const filter = listFilter(search, expanded, status);
    const sort: Record<string, SortOrder> = { [allowedSort.has(sortBy) ? sortBy : "createdAt"]: sortOrder };
    const [items, total] = await Promise.all([
      PostModel.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      PostModel.countDocuments(filter)
    ]);

    return json(200, {
      items: await hydrateSeries(items as PostResponse[]),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      expanded
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

    const [hydratedPost] = await hydrateSeries([post as PostResponse]);
    return json(200, hydratedPost ?? post);
  });
}

export async function create(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const body = parseJsonBody(event, createPostSchema);
    const { summary, ...postPayload } = body;
    await ensureSeriesPart(postPayload.series);
    const post = await PostModel.create(postPayload);
    const [hydratedPost] = await hydrateSeries([post.toObject() as PostResponse]);
    const jobResponse = await maybeCreatePostJobs({
      content: post.content,
      summary,
      createSummaryJob: createSummaryJobHandler,
      createGrammerCheckJob: createGrammerCheckJobHandler
    });

    return json(201, {
      ...(hydratedPost ?? post.toObject()),
      ...jobResponse
    });
  });
}

export async function update(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const body = parseJsonBody(event, updatePostSchema);
    const { summary, aiRequired, ...postPayload } = body;
    await ensureSeriesPart(postPayload.series, postId);
    const post = await PostModel.findByIdAndUpdate(postId, postPayload, { new: true, runValidators: true }).lean();

    if (!post) {
      throw new HttpError(404, "Post not found.");
    }

    const [hydratedPost] = await hydrateSeries([post as PostResponse]);
    
    const jobResponse = aiRequired ? await maybeCreatePostJobs({
      content: post.content,
      summary,
      createSummaryJob: createSummaryJobHandler,
      createGrammerCheckJob: createGrammerCheckJobHandler
    }) : {};

    return json(200, {
      ...(hydratedPost ?? post),
      ...jobResponse
    });
  });
}

export async function updateStatus(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const body = parseJsonBody(event, updatePostStatusSchema);
    const post = await PostModel.findByIdAndUpdate(postId, { status: body.status }, { new: true, runValidators: true }).lean();

    if (!post) {
      throw new HttpError(404, "Post not found.");
    }

    const [hydratedPost] = await hydrateSeries([post as PostResponse]);
    return json(200, hydratedPost ?? post);
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
