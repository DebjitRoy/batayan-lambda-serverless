import { z } from "zod";

export const postTypeSchema = z.enum(["travel", "books", "miscl", "guest"]);

export const sectionSchema = z.object({
  header: z.string().trim().max(150).default(""),
  content: z.string().default(""),
  image: z.string().default(""),
  imgDescription: z.string().trim().max(100).default(""),
  video: z.string().default(""),
  videoDescription: z.string().trim().max(100).default("")
});

export const postSeriesSchema = z.object({
  seriesId: z.string().trim().min(1),
  part: z.number().int().min(1)
});

export const postStatusSchema = z.enum(["draft", "published", "archived"]);

export const createPostSchema = z.object({
  title: z.string().trim().min(1).max(100),
  postType: postTypeSchema,
  gist: z.string().max(1000).default(""),
  visited: z.number().int().min(0).default(0),
  liked: z.number().int().min(0).default(0),
  photoHero: z.string().default("no-photo.jpg"),
  gallery: z.array(z.string()).default([]),
  content: z.array(sectionSchema).default([]),
  series: postSeriesSchema.optional(),
  status: postStatusSchema.default("draft"),
  searchBy: z.array(z.string().trim().min(1)).default([]),
  additionalInfo: z.string().default(""),
  summary: z.string().trim().max(50000).optional()
});

export const updatePostSchema = createPostSchema.partial();

export const updatePostStatusSchema = z.object({ status: postStatusSchema });
