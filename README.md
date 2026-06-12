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

## CloudFront SPA Routes

Direct browser links such as:

```text
https://d2ou81s2ipgc0n.cloudfront.net/post/5f942ac89de18f001783af45
```

must load React's `index.html` first. Otherwise CloudFront asks S3 for `/post/5f942ac89de18f001783af45`, and S3 returns `AccessDenied` because that object does not exist.

This project creates a CloudFront Function in `serverless.yml`:

```text
batayan-serverless-dev-spa-rewrite
```

The function rewrites non-API, non-asset browser routes to `/index.html`:

```js
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (
    uri === '/' ||
    uri.startsWith('/api/') ||
    uri.includes('.')
  ) {
    return request;
  }

  request.uri = '/index.html';
  return request;
}
```

Deploy or update the function:

```bash
npm run deploy -- --stage dev
```

Attach it in AWS Console:

```text
CloudFront -> Distributions -> E1SKIR1J0X07R -> Behaviors
```

Behavior order should be:

```text
/api/*  -> API Gateway origin, no SPA rewrite function
*       -> S3 origin, Viewer request CloudFront Function attached
```

Edit the default `*` behavior:

```text
Function associations -> Viewer request
Function type -> CloudFront Functions
Function -> batayan-serverless-dev-spa-rewrite
```

Save the behavior and wait until the distribution status is `Deployed`.

Then invalidate CloudFront:

```bash
aws cloudfront create-invalidation --distribution-id E1SKIR1J0X07R --paths "/*"
```

Test:

```text
https://d2ou81s2ipgc0n.cloudfront.net/post/5f942ac89de18f001783af45
```

Expected result: CloudFront serves `/index.html`, then React Router renders the post page. API requests such as `/api/posts` are not rewritten.

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

Register / login response:

```json
{
  "user": {
    "id": "user-id",
    "name": "Admin",
    "email": "admin@example.com",
    "role": "admin",
    "createdAt": "2026-06-07T00:00:00.000Z"
  },
  "token": "<jwt-token>"
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

Protected endpoints require:

```text
Authorization: Bearer <token>
```

#### List posts

Query parameters:

- `search` (string)
- `expanded` (`true` or `false`)
- `sortBy` (`createdAt`, `title`, `visited`, `liked`)
- `sortOrder` (`asc` or `desc`)
- `page` (number)
- `limit` (number)

Response:

```json
{
  "items": [
    {
      "_id": "post-id",
      "title": "A day in Kolkata",
      "postType": "travel",
      "gist": "A short summary",
      "createdAt": "2026-06-07T00:00:00.000Z",
      "visited": 0,
      "liked": 0,
      "photoHero": "no-photo.jpg",
      "gallery": [],
      "content": [],
      "series": null,
      "searchBy": ["kolkata", "travel"],
      "additionalInfo": "",
      "isSeries": false
    }
  ],
  "page": 1,
  "limit": 10,
  "total": 1,
  "totalPages": 1,
  "expanded": false
}
```

#### Get post

Response includes hydrated series data when the post belongs to a series.

```json
{
  "_id": "post-id",
  "title": "A day in Kolkata",
  "postType": "travel",
  "gist": "A short summary",
  "createdAt": "2026-06-07T00:00:00.000Z",
  "visited": 1,
  "liked": 0,
  "photoHero": "https://.../image.jpg",
  "gallery": [],
  "content": [
    {
      "_id": "section-id",
      "header": "Morning",
      "content": "Walked through the old streets.",
      "image": "",
      "imgDescription": "",
      "video": "",
      "videoDescription": ""
    }
  ],
  "series": {
    "seriesId": "507f1f77bcf86cd799439011",
    "title": "Kolkata Travel Notes",
    "part": 1,
    "totalParts": 5,
    "posts": [
      {
        "postId": "post-id",
        "title": "A day in Kolkata",
        "part": 1
      }
    ]
  },
  "searchBy": ["kolkata", "travel"],
  "additionalInfo": ""
}
```

#### Create post body

```json
{
  "title": "A day in Kolkata",
  "postType": "travel",
  "gist": "A short summary",
  "content": [
    {
      "header": "Morning",
      "content": "Walked through the old streets.",
      "image": "",
      "imgDescription": "",
      "video": "",
      "videoDescription": ""
    }
  ],
  "series": {
    "seriesId": "507f1f77bcf86cd799439011",
    "part": 1
  },
  "searchBy": ["kolkata", "travel"],
  "additionalInfo": ""
}
```

Create / update post response: same as get post response above.

#### Delete post response

```json
{
  "deleted": true,
  "id": "post-id"
}
```

#### Upload hero image body

```json
{
  "fileName": "cover.jpg",
  "contentType": "image/jpeg",
  "dataBase64": "<base64-image-data>"
}
```

#### Upload section image body

```json
{
  "fileName": "section.jpg",
  "contentType": "image/jpeg",
  "dataBase64": "<base64-image-data>"
}
```

If `dataBase64` is omitted, the request returns an upload URL and the expected public image URL.

Upload response:

```json
{
  "imageUrl": "https://.../posts/post-id/hero/<uuid>.jpg",
  "uploadUrl": "https://...",
  "post": {
    "_id": "post-id",
    "title": "A day in Kolkata",
    "photoHero": "https://.../posts/post-id/hero/<uuid>.jpg",
    "...": "..."
  }
}
```

### Series

- `GET /api/series`
- `GET /api/series/{seriesId}`
- `POST /api/series`
- `PUT /api/series/{seriesId}`
- `DELETE /api/series/{seriesId}`

Query parameters for list:

- `search` (string)
- `sortBy` (`createdAt`, `title`)
- `sortOrder` (`asc` or `desc`)
- `page` (number)
- `limit` (number)

Create / update series body:

```json
{
  "title": "Kolkata Travel Notes",
  "description": "A five part travel journal.",
  "postType": "travel",
  "searchBy": ["kolkata", "travel"]
}
```

List / get series response:

```json
{
  "items": [
    {
      "_id": "series-id",
      "title": "Kolkata Travel Notes",
      "description": "A five part travel journal.",
      "postType": "travel",
      "searchBy": ["kolkata", "travel"],
      "createdAt": "2026-06-07T00:00:00.000Z",
      "totalParts": 5,
      "posts": [
        {
          "postId": "post-id",
          "title": "A day in Kolkata",
          "part": 1
        }
      ]
    }
  ],
  "page": 1,
  "limit": 10,
  "total": 1,
  "totalPages": 1
}
```

Delete series response:

```json
{
  "deleted": true,
  "id": "series-id"
}
```

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

Reply to comment body:

```json
{
  "reply": "Thanks for reading."
}
```

Get comments response:

```json
{
  "items": [
    {
      "_id": "comment-id",
      "username": "Reader",
      "title": "Loved this",
      "description": "Thanks for the thoughtful post.",
      "createdAt": "2026-06-07T00:00:00.000Z",
      "reply": "",
      "post": "post-id"
    }
  ]
}
```

Get comment response:

```json
{
  "_id": "comment-id",
  "username": "Reader",
  "title": "Loved this",
  "description": "Thanks for the thoughtful post.",
  "createdAt": "2026-06-07T00:00:00.000Z",
  "reply": "",
  "post": "post-id"
}
```

Update comment response: same as get comment response.

Delete comment response:

```json
{
  "deleted": true,
  "id": "comment-id"
}
```
## deployed API url
Serverless deployed in following gateway:
https://us-east-1.console.aws.amazon.com/apigateway/main/develop/routes?api=tch4co3oq4&region=us-east-1&routes=jilrd5m&url=https%3A%2F%2Fus-east-1.console.aws.amazon.com%2Fapigateway%2Fhome%3Fregion%3Dus-east-1%23
 
  POST - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/auth/register
  POST - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/auth/login
  GET - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/series
  GET - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/series/{seriesId}
  POST - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/series
  PUT - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/series/{seriesId}
  DELETE - https://tch4co3oq4.execute-api.us-east-1.amazonaws.com/api/series/{seriesId}
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
  listSeries: batayan-serverless-dev-listSeries (10 MB)
  getSeries: batayan-serverless-dev-getSeries (10 MB)
  createSeries: batayan-serverless-dev-createSeries (10 MB)
  updateSeries: batayan-serverless-dev-updateSeries (10 MB)
  deleteSeries: batayan-serverless-dev-deleteSeries (10 MB)
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
