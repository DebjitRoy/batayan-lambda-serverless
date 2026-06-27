import { z } from "zod";

export const grammerCheckSchema = z.object({
  sections: z.array(z.string().trim().min(1).max(50000)).min(1).max(50)
});

export const grammerCheckSuggestionSchema = z.preprocess(
  (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const suggestion = (value as { suggestion?: unknown }).suggestion;

      if (suggestion === null || suggestion === undefined || suggestion === "") {
        return null;
      }
    }

    return value;
  },
  z.object({
    suggestion: z.string().trim().min(1),
    reason: z.string().trim().min(1)
  })
    .nullable()
);

export const grammerCheckResponseSchema = z.object({
  suggestions: z.array(grammerCheckSuggestionSchema)
});

export type GrammerCheckSuggestion = z.infer<typeof grammerCheckSuggestionSchema>;
