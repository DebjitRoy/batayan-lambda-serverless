import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema } from "../src/validation/auth.js";
import { createCommentSchema } from "../src/validation/comment.js";
import { createPostSchema, updatePostSchema } from "../src/validation/post.js";
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

  it("enforces comment limits", () => {
    expect(createCommentSchema.parse({ username: "A", title: "T", description: "D" }).reply).toBe("");
    expect(() => createCommentSchema.parse({ username: "A", title: "T", description: "x".repeat(501) })).toThrow();
  });

  it("allows only image upload content types", () => {
    expect(uploadImageSchema.parse({ fileName: "cover.jpg", contentType: "image/jpeg" }).contentType).toBe("image/jpeg");
    expect(() => uploadImageSchema.parse({ fileName: "cover.txt", contentType: "text/plain" })).toThrow();
  });
});
