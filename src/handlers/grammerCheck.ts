import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import OpenAI from "openai";
import { connectToDatabase } from "../db/mongo.js";
import { BackgroundJobModel } from "../models/backgroundJob.js";
import { requireAuth } from "../utils/auth.js";
import { assertObjectId } from "../utils/ids.js";
import { handle, HttpError, json, parseJsonBody, pathParam } from "../utils/http.js";
import { invokeWorker } from "../utils/worker.js";
import { buildPrompt as buildSummaryPrompt } from "./summary.js";
import { grammerCheckResponseSchema, grammerCheckSchema, type GrammerCheckSection, type GrammerCheckSuggestion } from "../validation/grammerCheck.js";

const OPENAI_MODEL = "gpt-4o-mini";

type GrammerCheckWorkerEvent = {
  jobId: string;
};

function fromTemplate(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((result, text, index) => `${result}${text}${String(values[index] ?? "")}`, "");
}

function buildGrammarPrompt(sections: GrammerCheckSection[]): string {
  return fromTemplate`You are a Bengali spelling and grammar editor.

Review each section independently. Specially check the Bengali punctuation like full stop (।), comma, and semicolon. Do not rewrite a good sentence just to change style.

Output rules:
- Return exactly one JSON object and no markdown.
- JSON shape must be: {"suggestions":[...]}. 
- The suggestions array must have exactly ${sections.length} items, in the same order as the input sections.
- Each array item must be either null or an object with keys {"sectionId":"same id from the input section","suggestion":"corrected text","reason":"short Bengali reason"}.
- If a section has no useful spelling or grammar suggestion, return null for that array item.
- If a section has a correction, return the full corrected section text in "suggestion", keep the same "sectionId" from the input section, and provide a short Bengali reason in "reason".
- Do not return an object with an empty suggestion or empty reason.
- Do not split a section into multiple suggestion objects.
- Do not remove escape characters like \n, \t, etc. from the text.
- Prefer natural, commonly used Bengali.
- Recommend correct punctuation and spelling, but do not change the meaning of the text.
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
    workId: String(job._id),
    jobType: job.jobType,
    data: job.data,
    status: job.status,
    result: job.result ?? null,
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

export async function createGrammerCheckJob(sections: Array<{ id: string; text: string }>): Promise<{ jobId: string; workId: string; status: "pending" }> {
  await connectToDatabase();

  const job = await BackgroundJobModel.create({
    jobType: "grammarCheck",
    data: { sections },
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
    workId: String(job._id),
    status: "pending"
  };
}

export async function createGrammerCheck(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    requireAuth(event);
    const body = parseJsonBody(event, grammerCheckSchema);
    const sections = body.sections.map((section: GrammerCheckSection) => ({ id: section.id, text: section.text }));
    return json(202, await createGrammerCheckJob(sections));
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
      const parsedSections = grammerCheckSchema.safeParse({
        sections: Array.isArray(job.data?.sections) ? job.data.sections : []
      });

      if (!parsedSections.success || parsedSections.data.sections.length === 0) {
        throw new HttpError(400, "Grammar check job data is invalid.");
      }

      const sections = parsedSections.data.sections;

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
