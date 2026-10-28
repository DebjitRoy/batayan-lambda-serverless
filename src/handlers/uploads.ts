import path from "node:path";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { findPost, updatePost, updateSectionImage } from "../db/posts.js";
import { requireAuth } from "../utils/auth.js";
import { assertObjectId } from "../utils/ids.js";
import { handle, HttpError, json, parseJsonBody, pathParam } from "../utils/http.js";
import { createUploadUrl, publicObjectUrl, uploadObject } from "../utils/s3.js";
import { uploadImageSchema } from "../validation/upload.js";

function imageKey(postId: string, fileName: string, sectionId?: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const safeExt = ext && ext.length <= 12 ? ext : "";
  if(sectionId) {
    return `photo_${postId}-${sectionId}${safeExt}`
  }
  return `photo_${postId}${safeExt}`
}

async function storeImage(key: string, contentType: string, dataBase64?: string): Promise<{ imageUrl: string; uploadUrl?: string }> {
  if (dataBase64) {
    return { imageUrl: await uploadObject(key, contentType, dataBase64) };
  }

  return {
    imageUrl: publicObjectUrl(key),
    uploadUrl: await createUploadUrl(key, contentType)
  };
}

export async function hero(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const body = parseJsonBody(event, uploadImageSchema);
    if (!(await findPost(postId))) throw new HttpError(404, "Post not found.");
    const key = imageKey(postId, body.fileName);
    const result = await storeImage(key, body.contentType, body.dataBase64);
    const fileName = path.basename(key);
    const post = await updatePost(postId, { photoHero: fileName });


    return json(200, { ...result, post });
  });
}

export async function section(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const postId = assertObjectId(pathParam(event, "postId"), "postId");
    const sectionId = assertObjectId(pathParam(event, "sectionId"), "sectionId");
    const body = parseJsonBody(event, uploadImageSchema);
    const existing = await findPost(postId);
    if (!existing?.content.some(section => section._id === sectionId)) throw new HttpError(404, "Post or section not found.");
    const key = imageKey(postId, body.fileName, sectionId);
    const fileName = path.basename(key);
    const result = await storeImage(key, body.contentType, body.dataBase64);
    const post = await updateSectionImage(postId, sectionId, fileName);


    return json(200, { ...result, post });
  });
}
