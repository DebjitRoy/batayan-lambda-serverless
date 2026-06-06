const requiredEnv = ["MONGODB_URI", "JWT_SECRET", "S3_BUCKET"] as const;

export type AppEnv = {
  mongodbUri: string;
  jwtSecret: string;
  s3Bucket: string;
  s3PublicBaseUrl?: string;
  awsRegion: string;
};

export function getEnv(): AppEnv {
  const missing = requiredEnv.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    mongodbUri: process.env.MONGODB_URI ?? "",
    jwtSecret: process.env.JWT_SECRET ?? "",
    s3Bucket: process.env.S3_BUCKET ?? "",
    s3PublicBaseUrl: process.env.S3_PUBLIC_BASE_URL,
    awsRegion: process.env.AWS_REGION ?? "us-east-1"
  };
}
