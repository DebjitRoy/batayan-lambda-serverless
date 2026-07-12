import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import OpenAI from "openai";
import { handle, HttpError, json, parseJsonBody } from "../utils/http.js";
import { createSummarySchema } from "../validation/summary.js";
import { BackgroundJobModel } from "../models/backgroundJob.js";
import { invokeWorker } from "../utils/worker.js";
import { requireAuth } from "../utils/auth.js";
import { connectToDatabase } from "../db/mongo.js";



const OPENAI_MODEL = "gpt-4o-mini";
const MAX_TOKENS = 200;
export function buildPrompt(content: string): string {
  return `তুমি একজন বাংলা সম্পাদক।


নিচের লেখাটির লেখিকার নিজের ভাষায় একটি সংক্ষিপ্ত সারাংশ তৈরি করো যেন সারাংশটি যেন লিখিকা নিজেই লিখছেন। 

rules:
- Write in Bengali with content's tone and style.
- Use Kolkata dialect if the content is in that dialect.
- If the content is in first person, use first person in the summary, but no need to start the summary with "আমি" or "আমার" if the content does not start with that.
- Maximum 500 characters.
- Highlight the main points.
- Do not add any extra information.
- Do not add any special characters or emojis. The text should be readable in plain text.


লেখা:

${content}`;
}

export async function createSummaryJob(content: string): Promise<{ jobId: string; status: "pending" }> {
  await connectToDatabase();

  const job = await BackgroundJobModel.create({
    jobType: "summary",
    data: {
      content
    },
    status: "pending",
    updatedAt: new Date()
  });

  try {
    await invokeWorker(String(job._id));
  } catch (error) {
    await BackgroundJobModel.findByIdAndUpdate(job._id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Failed to invoke background worker.",
      updatedAt: new Date()
    });
    throw error;
  }

  return {
    jobId: String(job._id),
    status: "pending"
  };
}

export async function createSummary(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const body = parseJsonBody(event, createSummarySchema);
    return json(202, await createSummaryJob(body.content));
  });
}

//--------- TODO: Remove this function after the new summary worker is fully implemented and tested. This function directly calls OpenAI API instead of using the background job worker.
export async function createSummaryV1(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const body = parseJsonBody(event, createSummarySchema);
    const apiKey = process.env.OPENAI_API_KEY?.trim();

    if (!apiKey) {
      throw new HttpError(500, "OPENAI_API_KEY is not configured.");
    }

    const client = new OpenAI({ apiKey });

    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: buildPrompt(body.content)
        }
      ]
    });

    const summary = typeof completion.choices[0]?.message?.content === "string"
      ? completion.choices[0].message.content.trim()
      : "";

    if (!summary) {
      throw new HttpError(502, "OpenAI returned an empty summary.");
    }

    return json(200, { summary });
  });
}

