import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const seriesSchema = new Schema(
  {
    title: { type: String, required: true, maxlength: 100, trim: true },
    description: { type: String, maxlength: 1000, default: "" },
    postType: { type: String, enum: ["travel", "books", "miscl", "guest"], default: undefined },
    searchBy: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

seriesSchema.index({ title: "text", description: "text", searchBy: "text" });
seriesSchema.index({ createdAt: -1 });

export type SeriesDocument = InferSchemaType<typeof seriesSchema>;

export const SeriesModel: Model<SeriesDocument> =
  (models.Series as Model<SeriesDocument> | undefined) ?? model<SeriesDocument>("Series", seriesSchema);
