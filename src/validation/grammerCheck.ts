import { z } from "zod";

const grammerCheckSectionSchema = z.object({
  id: z.string().trim().min(1).max(1000),
  text: z.string().trim().min(1).max(50000)
});

const legacySectionSchema = z.string().trim().min(1).max(50000);

export const grammerCheckSchema = z.object({
  sections: z.array(z.union([grammerCheckSectionSchema, legacySectionSchema])).min(1).max(50)
}).transform((data) => ({
  ...data,
  sections: data.sections.map((section) => typeof section === "string"
    ? { id: section, text: section }
    : section)
}));

export const grammerCheckSuggestionSchema = z.preprocess(
  (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const candidate = value as Record<string, unknown>;
      const suggestion = candidate.suggestion;

      if (suggestion === null || suggestion === undefined || suggestion === "") {
        return null;
      }

      if (typeof candidate.sectionid === "string" && candidate.sectionId === undefined) {
        candidate.sectionId = candidate.sectionid;
      }
    }

    return value;
  },
  z.object({
    sectionId: z.string().trim().min(1),
    suggestion: z.string().trim().min(1),
    reason: z.string().trim().min(1)
  })
    .nullable()
);

export const grammerCheckResponseSchema = z.object({
  suggestions: z.array(grammerCheckSuggestionSchema)
});

export type GrammerCheckSection = z.infer<typeof grammerCheckSectionSchema>;
export type GrammerCheckSuggestion = z.infer<typeof grammerCheckSuggestionSchema>;
