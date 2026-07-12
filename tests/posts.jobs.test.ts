import { describe, expect, it, vi } from "vitest";
import { maybeCreatePostJobs } from "../src/handlers/posts.js";

describe("maybeCreatePostJobs", () => {
  it("creates both background jobs when no summary is supplied", async () => {
    const createSummaryJob = vi.fn().mockResolvedValue({ jobId: "summary-job" });
    const createGrammerCheckJob = vi.fn().mockResolvedValue({ jobId: "grammar-job", workId: "grammar-job" });

    const result = await maybeCreatePostJobs({
      content: [{ header: "Intro", content: "Some content" }],
      createSummaryJob,
      createGrammerCheckJob
    });

    expect(createSummaryJob).toHaveBeenCalledTimes(1);
    expect(createGrammerCheckJob).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      summaryJobId: "summary-job",
      grammerJobId: "grammar-job"
    });
  });

  it("skips summary job creation when summary text already exists", async () => {
    const createSummaryJob = vi.fn().mockResolvedValue({ jobId: "summary-job" });
    const createGrammerCheckJob = vi.fn().mockResolvedValue({ jobId: "grammar-job", workId: "grammar-job" });

    const result = await maybeCreatePostJobs({
      content: [{ header: "Intro", content: "Some content" }],
      summary: "Existing summary",
      createSummaryJob,
      createGrammerCheckJob
    });

    expect(createSummaryJob).not.toHaveBeenCalled();
    expect(createGrammerCheckJob).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      summaryJobId: null,
      grammerJobId: "grammar-job"
    });
  });

  it("uses the section _id when building grammar sections", async () => {
    const createSummaryJob = vi.fn().mockResolvedValue({ jobId: "summary-job" });
    const createGrammerCheckJob = vi.fn().mockResolvedValue({ jobId: "grammar-job", workId: "grammar-job" });

    await maybeCreatePostJobs({
      content: [{ _id: "507f1f77bcf86cd799439011", header: "Intro", content: "Some content" }],
      createSummaryJob,
      createGrammerCheckJob
    });

    expect(createGrammerCheckJob).toHaveBeenCalledWith([
      {
        id: "507f1f77bcf86cd799439011",
        text: "Intro\nSome content"
      }
    ]);
  });
});
