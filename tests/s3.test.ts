import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn(), signed: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class { send = mocks.send; }, PutObjectCommand: class { constructor(public input: Record<string, unknown>) {} } }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mocks.signed }));
import { createUploadUrl, publicObjectUrl, uploadObject } from "../src/utils/s3.js";
describe("S3 upload contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks(); process.env.JWT_SECRET = "synthetic"; process.env.S3_BUCKET = "synthetic-images"; process.env.S3_PUBLIC_BASE_URL = "https://example.com/images/";
    mocks.send.mockResolvedValue({}); mocks.signed.mockResolvedValue("https://example.com/signed");
  });
  it("uses the same public-read ACL for direct and presigned uploads", async () => {
    await uploadObject("synthetic/direct.png", "image/png", "eA==");
    await createUploadUrl("synthetic/signed.png", "image/png");
    const direct = mocks.send.mock.calls[0]![0].input;
    const signed = mocks.signed.mock.calls[0]![1].input;
    expect(direct).toMatchObject({ Bucket: "synthetic-images", ACL: "public-read", ContentType: "image/png" });
    expect(signed).toMatchObject({ Bucket: "synthetic-images", ACL: "public-read", ContentType: "image/png" });
    expect(Buffer.from(direct.Body).toString()).toBe("x");
    expect(mocks.signed.mock.calls[0]![2]).toEqual({ expiresIn: 900 });
  });
  it("preserves and encodes image paths when constructing public URLs", () => {
    expect(publicObjectUrl("images/বাংলা cover.png")).toBe(`https://example.com/images/images/${encodeURIComponent("বাংলা cover.png")}`);
  });
});
