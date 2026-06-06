# Batayan Serverless APIs

TypeScript AWS Lambda APIs for the Batayan Blog application. The service uses MongoDB through Mongoose, validates requests with Zod, and stores post images in S3.

## Requirements

- Node.js 22 or newer
- AWS credentials configured for deployment
- MongoDB connection string
- S3 bucket for blog images

## Setup

```bash
npm install
cp .env.example .env
```

Set these values in `.env` or in your deployment environment:

- `MONGODB_URI`
- `JWT_SECRET`
- `S3_BUCKET`
- `S3_PUBLIC_BASE_URL`
- `AWS_REGION`

## Local Development

```bash
npm run dev
```

Serverless Offline serves the API at:

```text
http://localhost:4000
```

## Test and Build

```bash
npm test
npm run typecheck
npm run build
```

## Deploy

```bash
npm run deploy -- --stage dev
```

Remove the stack:

```bash
npm run remove -- --stage dev
```

## Authentication

Register or log in to receive a bearer token. Post mutations and image uploads require:

```text
Authorization: Bearer <token>
```

## Endpoints

### Auth

- `POST /api/auth/register`
- `POST /api/auth/login`

Register body:

```json
{
  "name": "Admin",
  "email": "admin@example.com",
  "password": "change-me-strong",
  "role": "admin"
}
```

Login body:

```json
{
  "email": "admin@example.com",
  "password": "change-me-strong"
}
```

### Posts

- `GET /api/posts`
- `GET /api/posts/{postId}`
- `POST /api/posts`
- `PUT /api/posts/{postId}`
- `DELETE /api/posts/{postId}`
- `PUT /api/posts/{postId}/upload`
- `PUT /api/posts/{postId}/sectionupload/{sectionId}`

List posts supports:

- `search`
- `sortBy`: `createdAt`, `title`, `visited`, `liked`
- `sortOrder`: `asc` or `desc`
- `page`
- `limit`

Create post body:

```json
{
  "title": "A day in Kolkata",
  "postType": "travel",
  "gist": "A short summary",
  "content": [
    {
      "header": "Morning",
      "content": "Walked through the old streets."
    }
  ],
  "searchBy": ["kolkata", "travel"],
  "additionalInfo": ""
}
```

Upload image body:

```json
{
  "fileName": "cover.jpg",
  "contentType": "image/jpeg",
  "dataBase64": "<base64-image-data>"
}
```

If `dataBase64` is omitted, the endpoint returns a short-lived `uploadUrl` and the final public `imageUrl`.

### Comments

- `GET /api/posts/{postId}/comments`
- `GET /api/posts/{postId}/comments/{commentId}`
- `POST /api/posts/{postId}/comments`
- `PUT /api/posts/{postId}/comments/{commentId}`
- `PUT /api/posts/{postId}/comments/{commentId}/reply`
- `DELETE /api/posts/{postId}/comments/{commentId}`

Create comment body:

```json
{
  "username": "Reader",
  "title": "Loved this",
  "description": "Thanks for the thoughtful post.",
  "reply": ""
}
```

Reply to comment body, admin bearer token required:

```json
{
  "reply": "Thanks for reading."
}
```
## deployed API url
Serverless deployed in following gateway:
https://us-east-1.console.aws.amazon.com/apigateway/main/develop/routes?api=tch4co3oq4&region=us-east-1&routes=jilrd5m&url=https%3A%2F%2Fus-east-1.console.aws.amazon.com%2Fapigateway%2Fhome%3Fregion%3Dus-east-1%23
 
  POST - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/auth/register
  POST - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/auth/login
  GET - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts
  GET - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts/{postId}
  POST - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts
  PUT - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts/{postId}
  DELETE - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts/{postId}
  PUT - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts/{postId}/upload
  PUT - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts/{postId}/sectionupload/{sectionId}
  GET - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts/{postId}/comments
  GET - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts/{postId}/comments/{commentId}
  POST - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts/{postId}/comments
  PUT - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts/{postId}/comments/{commentId}
  PUT - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts/{postId}/comments/{commentId}/reply
  DELETE - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/posts/{postId}/comments/{commentId}
functions:
  authRegister: batayan-serverless-dev-authRegister (10 MB)
  authLogin: batayan-serverless-dev-authLogin (10 MB)
  listPosts: batayan-serverless-dev-listPosts (10 MB)
  getPost: batayan-serverless-dev-getPost (10 MB)
  createPost: batayan-serverless-dev-createPost (10 MB)
  updatePost: batayan-serverless-dev-updatePost (10 MB)
  deletePost: batayan-serverless-dev-deletePost (10 MB)
  uploadPostHero: batayan-serverless-dev-uploadPostHero (10 MB)
  uploadPostSection: batayan-serverless-dev-uploadPostSection (10 MB)
  listComments: batayan-serverless-dev-listComments (10 MB)
  getComment: batayan-serverless-dev-getComment (10 MB)
  createComment: batayan-serverless-dev-createComment (10 MB)
  updateComment: batayan-serverless-dev-updateComment (10 MB)
  replyComment: batayan-serverless-dev-replyComment (10 MB)
  deleteComment: batayan-serverless-dev-deleteComment (10 MB)
