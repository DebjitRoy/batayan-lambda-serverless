import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import OpenAI from "openai";
import { connectToDatabase } from "../db/mongo.js";
import { BackgroundJobModel } from "../models/backgroundJob.js";
import { requireAuth } from "../utils/auth.js";
import { assertObjectId } from "../utils/ids.js";
import { handle, HttpError, json, parseJsonBody, pathParam } from "../utils/http.js";
import { invokeWorker } from "../utils/worker.js";
import { buildPrompt as buildSummaryPrompt } from "./summary.js";
import { grammerCheckResponseSchema, grammerCheckSchema, type GrammerCheckSuggestion } from "../validation/grammerCheck.js";

const OPENAI_MODEL = "gpt-4o-mini";

type GrammerCheckWorkerEvent = {
  jobId: string;
};

function fromTemplate(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((result, text, index) => `${result}${text}${String(values[index] ?? "")}`, "");
}

function buildGrammarPrompt(sections: string[]): string {
  return fromTemplate`You are a Bengali spelling and grammar editor.

Review each section independently. Specially check the bengali punctuations like fullstop(।) comma, semicolone. Do not rewrite a good sentence just to change style.

Rules:
- There can be several grammer or spelling mistakes in a section. If there are multiple mistakes, correct all of them.
- Return suggested entire text for a section where suggestions are made. Do not return only the corrected words.
- Return exactly one JSON object and no markdown.
- JSON shape must be: {"suggestions":[...]}.
- For a section with no useful spelling or grammar suggestion, return null for that array item.
- For a section with a suggestion, return {"suggestion":"corrected text","reason":"short Bengali reason"}.
- each suggestion for a section must contain the suggestion for entire section. Do not split the section into multiple suggestions.
- Do not remove escape characters like \n, \t, etc. from the text.
- If there is no suggestionfor a section, return original string as suggestion with reason as null. 
- The suggestions array must have exactly ${sections.length} items, in the same order as the input sections.
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

function serializeJob(job: {
  _id: unknown;
  jobType: string;
  data: unknown;
  status: string;
  result?: unknown;
  error?: string;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    jobId: String(job._id),
    jobType: job.jobType,
    data: job.data,
    status: job.status,
    result: job.result ?? null,
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
    const job = await BackgroundJobModel.create({
      jobType: "grammarCheck",
      data: { sections: body.sections },
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

    return json(202, {
      jobId: String(job._id),
      status: "pending"
    });
  });
}

export async function getGrammerCheck(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return getWorkerByJobId(event);
}

export async function getWorkerByJobId(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    await connectToDatabase();
    const jobId = assertObjectId(pathParam(event, "jobId"), "jobId");
    const job = await BackgroundJobModel.findById(jobId).lean();

    if (!job) {
      throw new HttpError(404, "Background job not found.");
    }

    return json(200, serializeJob(job));
  });
}

export async function processBackgroundJob(event: GrammerCheckWorkerEvent): Promise<void> {
  await connectToDatabase();
  const jobId = assertObjectId(event.jobId, "jobId");
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    await BackgroundJobModel.findByIdAndUpdate(jobId, {
      status: "failed",
      error: "OPENAI_API_KEY is not configured.",
      updatedAt: new Date()
    });
    return;
  }

  const job = await BackgroundJobModel.findByIdAndUpdate(
    jobId,
    { status: "processing", error: "", updatedAt: new Date() },
    { new: true }
  ).lean();

  if (!job) {
    throw new Error(`Background job not found: ${jobId}`);
  }

  try {
    const client = new OpenAI({ apiKey });
    console.log(`Processing background job: ${jobId}, type: ${job.jobType}`);

    if (job.jobType === "grammarCheck") {
      const sections = Array.isArray(job.data?.sections) ? job.data.sections : [];

      if (sections.length === 0) {
        throw new HttpError(400, "Grammar check job data is invalid.");
      }

      const completion = await client.chat.completions.create({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: buildGrammarPrompt(sections)
          }
        ]
      });

      const content = typeof completion.choices[0]?.message?.content === "string"
        ? completion.choices[0].message.content.trim()
        : "";

      if (!content) {
        throw new HttpError(502, "OpenAI returned an empty grammar check response.");
      }

      const suggestions = parseSuggestions(content, sections.length);
      await BackgroundJobModel.findByIdAndUpdate(jobId, {
        status: "completed",
        result: suggestions,
        error: "",
        updatedAt: new Date()
      });
      return;
    }

    if (job.jobType === "summary") {
      const content = typeof job.data?.content === "string" ? job.data.content : "";

      if (!content) {
        throw new HttpError(400, "Summary job data is invalid.");
      }

      const completion = await client.chat.completions.create({
        model: OPENAI_MODEL,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: buildSummaryPrompt(content)
          }
        ]
      });

      const summary = typeof completion.choices[0]?.message?.content === "string"
        ? completion.choices[0].message.content.trim()
        : "";

      if (!summary) {
        throw new HttpError(502, "OpenAI returned an empty summary.");
      }

      await BackgroundJobModel.findByIdAndUpdate(jobId, {
        status: "completed",
        result: { summary },
        error: "",
        updatedAt: new Date()
      });
      return;
    }

    throw new Error(`Unsupported background job type: ${job.jobType}`);
  } catch (error) {
    await BackgroundJobModel.findByIdAndUpdate(jobId, {
      status: "failed",
      error: error instanceof Error ? error.message : "Background job failed.",
      updatedAt: new Date()
    });
    throw error;
  }
}
