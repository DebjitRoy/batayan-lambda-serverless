import { z } from "zod";
import { postTypeSchema } from "./post.js";

export const createSeriesSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(""),
  postType: postTypeSchema.optional(),
  searchBy: z.array(z.string().trim().min(1)).default([])
});

export const updateSeriesSchema = createSeriesSchema.partial();
