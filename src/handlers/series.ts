import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { allSeries, findSeries, createSeries, updateSeries, deleteSeries } from "../db/series.js";
import { allPosts, sortRecords } from "../db/posts.js";
import type { Series } from "../db/entities.js";
import { requireAuth } from "../utils/auth.js";
import { assertObjectId } from "../utils/ids.js";
import { handle, HttpError, json, parseJsonBody, pathParam, queryNumber } from "../utils/http.js";
import { matchesSeriesSearch } from "../utils/text-search.js";
import { createSeriesSchema, updateSeriesSchema } from "../validation/series.js";

async function withPostSummary(series: Series[]) {
  if (!series.length) return [];
  const posts = await allPosts();
  return series.map(value => {
    const related = posts.filter(post => post.series?.seriesId === value._id).sort((a, b) => a.series!.part - b.series!.part).map(post => ({ postId: post._id, title: post.title, part: post.series!.part }));
    return { ...value, totalParts: related.length, posts: related };
  });
}
export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    const query = event.queryStringParameters;
    const page = queryNumber(query?.page, 1, 1, 100000);
    const limit = queryNumber(query?.limit, 10, 1, 50);
    const search = query?.search?.trim();
    const values = (await allSeries()).filter(value => !search || matchesSeriesSearch([value.title, value.description, ...value.searchBy], search));
    sortRecords(values, query?.sortBy === "title" ? "title" : "createdAt", query?.sortOrder === "asc");
    return json(200, { items: await withPostSummary(values.slice((page - 1) * limit, page * limit)), page, limit, total: values.length, totalPages: Math.ceil(values.length / limit) });
  });
}
export async function get(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    const value = await findSeries(assertObjectId(pathParam(event, "seriesId"), "seriesId"));
    if (!value) throw new HttpError(404, "Series not found.");
    return json(200, (await withPostSummary([value]))[0]!);
  });
}
export async function create(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const value = await createSeries(parseJsonBody(event, createSeriesSchema));
    return json(201, { ...value, totalParts: 0, posts: [] });
  });
}
export async function update(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const value = await updateSeries(assertObjectId(pathParam(event, "seriesId"), "seriesId"), parseJsonBody(event, updateSeriesSchema));
    return json(200, (await withPostSummary([value]))[0]!);
  });
}
export async function remove(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const id = assertObjectId(pathParam(event, "seriesId"), "seriesId");
    await deleteSeries(id);
    return json(200, { deleted: true, id });
  });
}
