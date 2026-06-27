import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";
import type { GrammerCheckSuggestion } from "../validation/grammerCheck.js";

const suggestionSchema = new Schema(
  {
    suggestion: { type: String, default: "", trim: true },
    reason: { type: String, default: "", trim: true }
  },
  { _id: false, versionKey: false }
);

const grammerCheckJobSchema = new Schema(
  {
    sections: { type: [String], required: true },
    status: { type: String, required: true, enum: ["pending", "processing", "completed", "failed"], default: "pending" },
    result: { type: [suggestionSchema], default: undefined },
    resultNulls: { type: [Boolean], default: undefined },
    error: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

grammerCheckJobSchema.index({ createdAt: -1 });

export type GrammerCheckJobDocument = InferSchemaType<typeof grammerCheckJobSchema>;
export type GrammerCheckResult = Array<InferSchemaType<typeof suggestionSchema> | null>;

export function encodeResult(result: GrammerCheckSuggestion[]): {
  result: Array<InferSchemaType<typeof suggestionSchema>>;
  resultNulls: boolean[];
} {
  return {
    result: result.map((item) => item ?? { suggestion: "", reason: "" }),
    resultNulls: result.map((item) => item === null)
  };
}

export function decodeResult(job: {
  result?: Array<{ suggestion?: string; reason?: string }> | null;
  resultNulls?: boolean[] | null;
}): GrammerCheckResult | null {
  if (!job.result || !job.resultNulls) return null;

  return job.result.map((item, index) => (
    job.resultNulls?.[index]
      ? null
      : { suggestion: item.suggestion ?? "", reason: item.reason ?? "" }
  ));
}

export const GrammerCheckJobModel: Model<GrammerCheckJobDocument> =
  (models.GrammerCheckJob as Model<GrammerCheckJobDocument> | undefined) ??
  model<GrammerCheckJobDocument>("GrammerCheckJob", grammerCheckJobSchema);
