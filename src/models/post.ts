import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const sectionSchema = new Schema(
  {
    header: { type: String, maxlength: 150, trim: true },
    content: { type: String, default: "" },
    image: { type: String, default: "" },
    imgDescription: { type: String, maxlength: 100, default: "" },
    video: { type: String, default: "" },
    videoDescription: { type: String, maxlength: 100, default: "" }
  },
  { _id: true, versionKey: false }
);

const seriesSchema = new Schema(
  {
    seriesId: { type: String, required: true, trim: true },
    part: { type: Number, required: true, min: 1 }
  },
  { _id: false, versionKey: false }
);

const postSchema = new Schema(
  {
    title: { type: String, required: true, maxlength: 100, trim: true },
    postType: { type: String, required: true, enum: ["travel", "books", "miscl", "guest"] },
    gist: { type: String, maxlength: 1000, default: "" },
    status: { type: String, enum: ["draft", "published", "archived"], default: "draft" },
    createdAt: { type: Date, default: Date.now },
    visited: { type: Number, default: 0, min: 0 },
    liked: { type: Number, default: 0, min: 0 },
    photoHero: { type: String, default: "no-photo.jpg" },
    gallery: { type: [String], default: [] },
    content: { type: [sectionSchema], default: [] },
    series: { type: seriesSchema, default: undefined },
    searchBy: { type: [String], default: [] },
    additionalInfo: { type: String, default: "" }
  },
  { versionKey: false }
);

postSchema.index({ title: "text", gist: "text", searchBy: "text", additionalInfo: "text" });
postSchema.index({ createdAt: -1 });
postSchema.index({ "series.seriesId": 1, "series.part": 1 });

export type PostDocument = InferSchemaType<typeof postSchema>;

export const PostModel: Model<PostDocument> =
  (models.Post as Model<PostDocument> | undefined) ?? model<PostDocument>("Post", postSchema);
