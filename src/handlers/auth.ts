import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { connectToDatabase } from "../db/mongo.js";
import { UserModel } from "../models/user.js";
import { hashPassword, signToken, verifyPassword } from "../utils/auth.js";
import { handle, HttpError, json, parseJsonBody } from "../utils/http.js";
import { loginSchema, registerSchema } from "../validation/auth.js";

function publicUser(user: { _id: unknown; name: string; email: string; role: string; createdAt: Date }) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt
  };
}

export async function register(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    await connectToDatabase();
    const body = parseJsonBody(event, registerSchema);
    const existing = await UserModel.findOne({ email: body.email }).lean();

    if (existing) {
      throw new HttpError(409, "A user with this email already exists.");
    }

    const user = await UserModel.create({
      ...body,
      password: await hashPassword(body.password)
    });
    const token = signToken({ sub: String(user._id), email: user.email, role: user.role });

    return json(201, { user: publicUser(user), token });
  });
}

export async function login(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return handle(async () => {
    await connectToDatabase();
    const body = parseJsonBody(event, loginSchema);
    const user = await UserModel.findOne({ email: body.email });

    if (!user || !(await verifyPassword(body.password, user.password))) {
      throw new HttpError(401, "Email or password is incorrect.");
    }

    const token = signToken({ sub: String(user._id), email: user.email, role: user.role });
    return json(200, { user: publicUser(user), token });
  });
}
