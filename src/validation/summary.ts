import { z } from "zod";

export const createSummarySchema = z.object({
  content: z.string().trim().min(1).max(50000)
});
