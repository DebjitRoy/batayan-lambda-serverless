import type { z } from "zod";
import type { createPostSchema, sectionSchema } from "../validation/post.js";
import type { createSeriesSchema } from "../validation/series.js";
export type Section = z.infer<typeof sectionSchema> & { _id: string };
export type Post = Omit<z.infer<typeof createPostSchema>, "summary" | "aiRequired" | "aiSummaryJobId" | "aiGrammerJobId" | "content"> & { _id: string; createdAt: string; content: Section[] };
export type Series = z.infer<typeof createSeriesSchema> & { _id: string; createdAt: string };
export type Comment = { _id: string; post: string; username: string; title: string; description: string; reply: string; createdAt: string };
export type User = { _id: string; name: string; email: string; password: string; role: "admin" | "author" | "guest" | "user"; createdAt: string };
export type Job = { _id: string; jobType: "summary" | "grammarCheck"; data: { content?: string; sections?: Array<{ id: string; text: string }> }; status: "pending" | "processing" | "completed" | "failed"; result?: unknown; error: string; createdAt: string; updatedAt: string };
