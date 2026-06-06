import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { HttpError, parseJsonBody, pathParam, queryNumber } from "../src/utils/http.js";
import { createPostSchema } from "../src/validation/post.js";

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "",
    rawPath: "",
    rawQueryString: "",
    headers: {},
    requestContext: {} as APIGatewayProxyEventV2["requestContext"],
    isBase64Encoded: false,
    ...overrides
  };
}

describe("http utilities", () => {
  it("parses and validates JSON bodies", () => {
    const body = parseJsonBody(
      event({
        body: JSON.stringify({
          title: "Post",
          postType: "travel"
        })
      }),
      createPostSchema
    );

    expect(body.title).toBe("Post");
    expect(body.photoHero).toBe("no-photo.jpg");
    expect(body.content).toEqual([]);
  });

  it("rejects invalid JSON bodies", () => {
    expect(() => parseJsonBody(event({ body: "{" }), createPostSchema)).toThrow(HttpError);
  });

  it("requires path parameters", () => {
    expect(pathParam(event({ pathParameters: { postId: "abc" } }), "postId")).toBe("abc");
    expect(() => pathParam(event(), "postId")).toThrow("Missing path parameter");
  });

  it("bounds numeric query values", () => {
    expect(queryNumber("25", 10, 1, 50)).toBe(25);
    expect(queryNumber("-1", 10, 1, 50)).toBe(1);
    expect(queryNumber("1000", 10, 1, 50)).toBe(50);
    expect(queryNumber("nope", 10, 1, 50)).toBe(10);
  });
});
