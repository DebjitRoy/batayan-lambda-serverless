import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { Post } from "../db/entities.js";
import { allPosts, createPost, updatePost, deletePost, visitPost, hydrateSeries, sortRecords } from "../db/posts.js";
import { requireAuth } from "../utils/auth.js";
import { assertObjectId } from "../utils/ids.js";
import { handle, json, parseJsonBody, pathParam, queryNumber } from "../utils/http.js";
import { createGrammerCheckJob as createGrammerCheckJobHandler } from "./grammerCheck.js";
import { createSummaryJob as createSummaryJobHandler } from "./summary.js";
import { createPostSchema, updatePostSchema, updatePostStatusSchema } from "../validation/post.js";

const allowedSort = new Set(["createdAt", "title", "visited", "liked"]);
type PostContentSection = { id?: string | null; _id?: unknown; header?: string | null; content?: string | null };

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

export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    const page = queryNumber(event.queryStringParameters?.page, 1, 1, 100000);
    const limit = queryNumber(event.queryStringParameters?.limit, 10, 1, 50);
    const search = event.queryStringParameters?.search?.trim();
    const expanded = event.queryStringParameters?.expanded === "true";
    const status = event.queryStringParameters?.status?.trim();
    const sortBy = event.queryStringParameters?.sortBy ?? "createdAt";
    const items = (await allPosts()).filter(post => {
      if (search && !post.searchBy.some(tag => tag.toLowerCase().includes(search.toLowerCase()))) return false;
      if (!expanded && post.series?.seriesId && post.series.part !== 1) return false;
      if (status === "published" && (post.status ?? "published") !== "published") return false;
      if ((status === "draft" || status === "archived") && post.status !== status) return false;
      return true;
    });
    sortRecords(items, (allowedSort.has(sortBy) ? sortBy : "createdAt") as keyof Post, event.queryStringParameters?.sortOrder === "asc");
    const total = items.length;
    return json(200, {
      items: await hydrateSeries(items.slice((page - 1) * limit, page * limit)),
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
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const post = await visitPost(postId);


    const [hydratedPost] = await hydrateSeries([post]);
    return json(200, hydratedPost ?? post);
  });
}

export async function create(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const body = parseJsonBody(event, createPostSchema);
    const { summary, ...postPayload } = body;
    const post = await createPost(postPayload);
    const [hydratedPost] = await hydrateSeries([post]);
    const jobResponse = await maybeCreatePostJobs({
      content: post.content,
      summary,
      createSummaryJob: createSummaryJobHandler,
      createGrammerCheckJob: createGrammerCheckJobHandler
    });

    return json(201, {
      ...(hydratedPost ?? post),
      ...jobResponse
    });
  });
}

export async function update(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const body = parseJsonBody(event, updatePostSchema);
    const { summary, aiRequired, ...postPayload } = body;
    const post = await updatePost(postId, postPayload);


    const [hydratedPost] = await hydrateSeries([post]);
    
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
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const body = parseJsonBody(event, updatePostStatusSchema);
    const post = await updatePost(postId, { status: body.status });


    const [hydratedPost] = await hydrateSeries([post]);
    return json(200, hydratedPost ?? post);
  });
}

export async function remove(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    await deletePost(postId);


    return json(200, { deleted: true, id: postId });
  });
}
