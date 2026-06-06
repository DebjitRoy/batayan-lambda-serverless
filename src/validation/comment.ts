import { z } from "zod";

export const createCommentSchema = z.object({
  username: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  reply: z.string().trim().max(500).default("")
});

export const updateCommentSchema = createCommentSchema.partial();

export const replyCommentSchema = z.object({
  reply: z.string().trim().min(1).max(500)
});
