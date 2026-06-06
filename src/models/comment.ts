import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const commentSchema = new Schema(
  {
    username: { type: String, required: true, maxlength: 100, trim: true },
    title: { type: String, required: true, maxlength: 100, trim: true },
    description: { type: String, required: true, maxlength: 500, trim: true },
    createdAt: { type: Date, default: Date.now },
    reply: { type: String, maxlength: 500, default: "" },
    post: { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true }
  },
  { versionKey: false }
);

export type CommentDocument = InferSchemaType<typeof commentSchema>;

export const CommentModel: Model<CommentDocument> =
  (models.Comment as Model<CommentDocument> | undefined) ?? model<CommentDocument>("Comment", commentSchema);
