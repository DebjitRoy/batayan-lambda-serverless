import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import OpenAI from "openai";
import { handle, HttpError, json, parseJsonBody } from "../utils/http.js";
import { createSummarySchema } from "../validation/summary.js";
import { requireAuth } from "../utils/auth.js";

const OPENAI_MODEL = "gpt-4o-mini";
const MAX_TOKENS = 200;

/**
 * 
 * @param content return `তুমি একজন বাংলা সম্পাদক।

নিচের লেখাটির একটি সংক্ষিপ্ত সারাংশ তৈরি করো।

নিয়ম:
- বাংলা ভাষায় লিখবে।
- সর্বোচ্চ ৫০০ অক্ষর।
- মূল বিষয়গুলো তুলে ধরবে।
- কোনো অতিরিক্ত তথ্য যোগ করবে না।

লেখা:

${content}`;
 * @returns 
 */
function buildPrompt(content: string): string {
  return `তুমি একজন বাংলা সম্পাদক।

নিচের লেখাটির লেখিকার নিজের ভাষায় একটি সংক্ষিপ্ত সারাংশ তৈরি করো যেন সারাংশটি যেন লিখিকা নিজেই লিখছেন। 

rules:
- Write in Bengali with content's tone and style.
- Use Kolkata dialect if the content is in that dialect.
- If the content is in first person, use first person in the summary.
- Maximum 500 characters.
- Highlight the main points.
- Do not add any extra information.
- Do not add any special characters or emojis. The text should be readable in plain text.

লেখা:

${content}`;
}

export async function createSummary(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
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
