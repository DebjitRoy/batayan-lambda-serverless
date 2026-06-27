import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { HttpError } from "../utils/http.js";

export function getLambdaClient(): LambdaClient {
  if (process.env.IS_OFFLINE) {
    return new LambdaClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.LAMBDA_ENDPOINT ?? "http://localhost:4002",
      credentials: {
        accessKeyId: "offline",
        secretAccessKey: "offline"
      }
    });
  }

  return new LambdaClient({ region: process.env.AWS_REGION ?? "us-east-1" });
}

export async function invokeWorker(jobId: string): Promise<void> {
  const functionName = process.env.BACKGROUND_JOB_WORKER_FUNCTION_NAME;
  console.log(`Invoking background worker for jobId: ${jobId} using function: ${functionName}`);

  if (!functionName) {
    throw new HttpError(500, "BACKGROUND_JOB_WORKER_FUNCTION_NAME is not configured.");
  }

  await getLambdaClient().send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ jobId }))
    })
  );
}
