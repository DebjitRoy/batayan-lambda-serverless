import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getEnv } from "../config/env.js";

let client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!client) {
    client = new S3Client({ region: getEnv().awsRegion });
  }

  return client;
}

export function publicObjectUrl(key: string): string {
  const { s3Bucket, s3PublicBaseUrl } = getEnv();
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return s3PublicBaseUrl ? `${s3PublicBaseUrl.replace(/\/$/, "")}/${encodedKey}` : `https://${s3Bucket}.s3.amazonaws.com/${encodedKey}`;
}

export async function uploadObject(key: string, contentType: string, dataBase64: string): Promise<string> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getEnv().s3Bucket,
      Key: key,
      Body: Buffer.from(dataBase64, "base64"),
      ContentType: contentType,
      ACL: "public-read"
    })
  );

  return publicObjectUrl(key);
}

export async function createUploadUrl(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    getS3Client(),
    new PutObjectCommand({
      Bucket: getEnv().s3Bucket,
      Key: key,
      ContentType: contentType
    }),
    { expiresIn: 900 }
  );
}
