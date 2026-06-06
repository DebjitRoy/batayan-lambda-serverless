import { z } from "zod";
import { Buffer } from "buffer";

const MAX_IMAGE_BYTES = 500 * 1024; // 500 KB

export const uploadImageSchema = z
  .object({
    fileName: z.string().trim().min(1).max(180),
    contentType: z.string().trim().regex(/^image\/[a-z0-9.+-]+$/i),
    dataBase64: z.string().optional()
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!val.dataBase64) return;

    try {
      const size = Buffer.from(val.dataBase64, "base64").length;
      if (size > MAX_IMAGE_BYTES) {
        ctx.addIssue({
          code: "custom",
          message: "Image must be at most 500 KB",
          path: ["dataBase64"]
        });
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Invalid base64 data",
        path: ["dataBase64"]
      });
    }
  });
