// Bundled only into the temporary Phase 3 smoke-test Lambda, never the service.
import { register, login } from "../src/handlers/auth.js";
import { createPost, visitPost, deletePost } from "../src/db/posts.js";
import { createJob, findJob } from "../src/db/jobs.js";
import { invokeWorker } from "../src/utils/worker.js";
import { uploadObject, createUploadUrl, publicObjectUrl } from "../src/utils/s3.js";
import { processBackgroundJob } from "../src/handlers/grammerCheck.js";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

export const worker = processBackgroundJob;
export async function handler(event: { action: string; key?: string; postId?: string; jobId?: string; email?: string; dataBase64?: string }) {
  switch (event.action) {
    case "register": return register({ body: JSON.stringify({ name: "Synthetic smoke", email: event.email, password: "synthetic-aws-password" }), headers: {}, isBase64Encoded: false } as APIGatewayProxyEventV2);
    case "login": return login({ body: JSON.stringify({ email: event.email, password: "synthetic-aws-password" }), headers: {}, isBase64Encoded: false } as APIGatewayProxyEventV2);
    case "create": return createPost({ title: "Synthetic AWS smoke", postType: "books" });
    case "visit": return visitPost(event.postId!);
    case "delete": await deletePost(event.postId!); return { deleted: true };
    case "upload": return { imageUrl: await uploadObject(event.key!, "image/png", event.dataBase64!) };
    case "presign": return { uploadUrl: await createUploadUrl(event.key!, "image/png"), imageUrl: publicObjectUrl(event.key!) };
    case "enqueue": {
      const job = await createJob("summary", { content: "Synthetic AWS smoke; paid AI disabled." });
      await invokeWorker(job._id); return { jobId: job._id };
    }
    case "poll": return findJob(event.jobId!);
    default: throw new Error("Unknown synthetic smoke action.");
  }
}
