import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import OpenAI from "openai";
import { connectToDatabase } from "../db/mongo.js";
import { decodeResult, encodeResult, GrammerCheckJobModel } from "../models/grammerCheckJob.js";
import { requireAuth } from "../utils/auth.js";
import { assertObjectId } from "../utils/ids.js";
import { handle, HttpError, json, parseJsonBody, pathParam } from "../utils/http.js";
import { grammerCheckResponseSchema, grammerCheckSchema, type GrammerCheckSuggestion } from "../validation/grammerCheck.js";

const OPENAI_MODEL = "gpt-4o-mini";

type GrammerCheckWorkerEvent = {
  jobId: string;
};

function fromTemplate(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((result, text, index) => `${result}${text}${String(values[index] ?? "")}`, "");
}

function buildPrompt(sections: string[]): string {
  return fromTemplate`You are a Bengali spelling and grammar editor.

Review each section independently. Specially check the bengali punctuations like fullstop(।) comma, semicolone. Do not rewrite a good sentence just to change style.

Rules:
- There can be several grammer or spelling mistakes in a section. If there are multiple mistakes, correct all of them.
- Return suggested entire text for a section where suggestions are made. Do not return only the corrected words.
- Return exactly one JSON object and no markdown.
- JSON shape must be: {"suggestions":[...]}.
- The suggestions array must have exactly ${sections.length} items, in the same order as the input sections.
- For a section with no useful spelling or grammar suggestion, return null for that array item.
- For a section with a suggestion, return {"suggestion":"corrected text","reason":"short Bengali reason"}.
- Prefer natural, commonly used Bengali.
- recommend correct punctuation and spelling, but do not change the meaning of the text.
- Do not rewrite a good sentence just to change style.
- Do not add facts or commentary.

Sections JSON:
${JSON.stringify(sections)}`;
}

function parseSuggestions(content: string, expectedLength: number): GrammerCheckSuggestion[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new HttpError(502, "OpenAI returned invalid JSON.");
  }

  const result = grammerCheckResponseSchema.safeParse(parsed);

  if (!result.success) {
    throw new HttpError(502, "OpenAI returned malformed grammar suggestions.", result.error.issues);
  }

  if (result.data.suggestions.length !== expectedLength) {
    throw new HttpError(502, "OpenAI returned an unexpected number of grammar suggestions.");
  }

  return result.data.suggestions;
}

function getLambdaClient(): LambdaClient {
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

async function invokeWorker(jobId: string): Promise<void> {
  const functionName = process.env.GRAMMER_CHECK_WORKER_FUNCTION_NAME;

  if (!functionName) {
    throw new HttpError(500, "GRAMMER_CHECK_WORKER_FUNCTION_NAME is not configured.");
  }

  await getLambdaClient().send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ jobId } satisfies GrammerCheckWorkerEvent))
    })
  );
}

function serializeJob(job: {
  _id: unknown;
  status: string;
  result?: Array<{ suggestion?: string; reason?: string }> | null;
  resultNulls?: boolean[] | null;
  error?: string;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    jobId: String(job._id),
    status: job.status,
    result: decodeResult(job),
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

export async function createGrammerCheck(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const body = parseJsonBody(event, grammerCheckSchema);
    const job = await GrammerCheckJobModel.create({
      sections: body.sections,
      status: "pending",
      updatedAt: new Date()
    });

    try {
      await invokeWorker(String(job._id));
    } catch (error) {
      await GrammerCheckJobModel.findByIdAndUpdate(job._id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Failed to invoke grammar check worker.",
        updatedAt: new Date()
      });
      throw error;
    }

    return json(202, {
      jobId: String(job._id),
      status: "pending"
    });
  });
}

export async function getGrammerCheck(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const jobId = assertObjectId(pathParam(event, "jobId"), "jobId");
    const job = await GrammerCheckJobModel.findById(jobId).lean();

    if (!job) {
      throw new HttpError(404, "Grammar check job not found.");
    }

    return json(200, serializeJob(job));
  });
}

export async function processGrammerCheck(event: GrammerCheckWorkerEvent): Promise<void> {
  await connectToDatabase();
  const jobId = assertObjectId(event.jobId, "jobId");
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    await GrammerCheckJobModel.findByIdAndUpdate(jobId, {
      status: "failed",
      error: "OPENAI_API_KEY is not configured.",
      updatedAt: new Date()
    });
    return;
  }

  const job = await GrammerCheckJobModel.findByIdAndUpdate(
    jobId,
    { status: "processing", error: "", updatedAt: new Date() },
    { new: true }
  ).lean();

  if (!job) {
    throw new Error(`Grammar check job not found: ${jobId}`);
  }

  try {
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: buildPrompt(job.sections)
        }
      ]
    });
    const content = typeof completion.choices[0]?.message?.content === "string"
      ? completion.choices[0].message.content.trim()
      : "";

    if (!content) {
      throw new HttpError(502, "OpenAI returned an empty grammar check response.");
    }

    const encoded = encodeResult(parseSuggestions(content, job.sections.length));
    await GrammerCheckJobModel.findByIdAndUpdate(jobId, {
      status: "completed",
      result: encoded.result,
      resultNulls: encoded.resultNulls,
      error: "",
      updatedAt: new Date()
    });
  } catch (error) {
    await GrammerCheckJobModel.findByIdAndUpdate(jobId, {
      status: "failed",
      error: error instanceof Error ? error.message : "Grammar check failed.",
      updatedAt: new Date()
    });
    throw error;
  }
}
