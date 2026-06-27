import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema } from "../src/validation/auth.js";
import { createCommentSchema, replyCommentSchema } from "../src/validation/comment.js";
import { createPostSchema, updatePostSchema } from "../src/validation/post.js";
import { createSeriesSchema, updateSeriesSchema } from "../src/validation/series.js";
import { createSummarySchema } from "../src/validation/summary.js";
import { uploadImageSchema } from "../src/validation/upload.js";

describe("request validation", () => {
  it("normalizes auth input", () => {
    const user = registerSchema.parse({
      name: "Deb",
      email: "DEB@example.com",
      password: "password123"
    });

    expect(user.email).toBe("deb@example.com");
    expect(user.role).toBe("author");
    expect(() => loginSchema.parse({ email: "bad", password: "x" })).toThrow();
  });

  it("enforces post limits and enum values", () => {
    expect(createPostSchema.parse({ title: "Book note", postType: "books" }).postType).toBe("books");
    expect(updatePostSchema.parse({ gist: "updated" }).gist).toBe("updated");
    expect(() => createPostSchema.parse({ title: "x".repeat(101), postType: "travel" })).toThrow();
    expect(() => createPostSchema.parse({ title: "Post", postType: "food" })).toThrow();
  });

  it("validates optional post series metadata", () => {
    const post = createPostSchema.parse({
      title: "Part three",
      postType: "books",
      series: {
        seriesId: "507f1f77bcf86cd799439011",
        part: 3
      }
    });

    expect(post.series?.part).toBe(3);
    expect(() =>
      createPostSchema.parse({
        title: "Bad series",
        postType: "books",
        series: {
          seriesId: "",
          part: 1
        }
      })
    ).toThrow();
  });

  it("validates searchable series metadata", () => {
    const series = createSeriesSchema.parse({
      title: "Kolkata Travel Notes",
      postType: "travel",
      searchBy: ["kolkata", "travel"]
    });

    expect(series.description).toBe("");
    expect(series.searchBy).toEqual(["kolkata", "travel"]);
    expect(updateSeriesSchema.parse({ title: "Updated" }).title).toBe("Updated");
    expect(() => createSeriesSchema.parse({ title: "", postType: "travel" })).toThrow();
    expect(() => createSeriesSchema.parse({ title: "Bad", postType: "food" })).toThrow();
  });

  it("enforces comment limits", () => {
    expect(createCommentSchema.parse({ username: "A", title: "T", description: "D" }).reply).toBe("");
    expect(replyCommentSchema.parse({ reply: "Thanks for reading." }).reply).toBe("Thanks for reading.");
    expect(() => createCommentSchema.parse({ username: "A", title: "T", description: "x".repeat(501) })).toThrow();
    expect(() => replyCommentSchema.parse({ reply: "" })).toThrow();
    expect(() => replyCommentSchema.parse({ reply: "x".repeat(501) })).toThrow();
  });

  it("validates summary requests", () => {
    const summary = createSummarySchema.parse({ content: "This is a long article about travel." });

    expect(summary.content).toBe("This is a long article about travel.");
    expect(() => createSummarySchema.parse({ content: "   " })).toThrow();
  });

  it("allows only image upload content types", () => {
    expect(uploadImageSchema.parse({ fileName: "cover.jpg", contentType: "image/jpeg" }).contentType).toBe("image/jpeg");
    expect(() => uploadImageSchema.parse({ fileName: "cover.txt", contentType: "text/plain" })).toThrow();
  });
});
