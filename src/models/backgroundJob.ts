import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

export const backgroundJobTypeValues = ["grammarCheck", "summary"] as const;
export type BackgroundJobType = (typeof backgroundJobTypeValues)[number];

const backgroundJobSchema = new Schema(
  {
    jobType: { type: String, required: true, enum: backgroundJobTypeValues },
    data: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      required: true,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending"
    },
    result: { type: Schema.Types.Mixed, default: undefined },
    error: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

backgroundJobSchema.index({ createdAt: -1 });

export type BackgroundJobDocument = InferSchemaType<typeof backgroundJobSchema>;

export const BackgroundJobModel: Model<BackgroundJobDocument> =
  (models.BackgroundJob as Model<BackgroundJobDocument> | undefined) ??
  model<BackgroundJobDocument>("BackgroundJob", backgroundJobSchema);
