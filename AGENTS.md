# Batayan Serverless APIs

## Business Requirement

- Backend services for Batayan Blog application
- A Nodejs based serverless application hosted in AWS lambda.
- Uses data stored in mongo DB
- API Posts - /api/posts
    - GET /posts -  get a list of posts. Allows search, sort(default created at desc) and pagination
    - GET /posts/{postId} - get a single post by id
    - POST /posts - create a post
    - PUT /posts/{postId}
    - DELETE /posts/{postId}
    - PUT /posts/:postId/upload - uploads an image to s3 bucket for a post cover
    - PUT /posts/:postId/sectionupload/:sectionid -  upload an image for a post's section
- API Comments - /api/posts/comments
    - GET /api/posts/:postId/comments - Get all comments
    - GET /api/posts/:postId/comments/:commentId
    - POST /api/posts/:postId/comments - create a new comment for a post
    - PUT /api/posts/:postId/comments/:commentId
    - DELETE /api/posts/:postId/comments/:commentId
- API User /api/auth
    - POST /api/auth/register -  stores user data( name, email, password, role) in db. The password being encrypted. Basic authentication 
    - POST /api/auth/login


## DB Schemas

- User
    - name, email, role, password, createdAt - consider using saving encrypted password 
- Post
    - title(max 100 chars)
    - postType( enum: ["travel", "books", "miscl", "guest"])
    - gist (max 1000 chars)
    - createdAt
    - visited
    - liked
    - photoHero(default: "no-photo.jpg",)- string(s3 url)
    - gallery (string[])
    - content ([Section])
    - searchBy (string[])
    - additionalInfo: string
- Section
    - header (max 150)
    - content
    - image: string(s3 url)
    - imgDescription (max 100)
    - video:(string url)
    - videoDescription(max 100)
- Comment
    - username (max 100)
    - title (max 100)
    - description (max 500)
    - createdAt
    - reply (max 500)
    - post - ref Post Schema



## Technical Details

- Implement as a Node JS typescript App
- It uses MongoDB to store nosql data.
- Create a serverless.yml and each service as lambdas
- This application services uses S3 bucket for images
- securely save the mongo an S3 urls
- Write README to explain how to use serverless to deploy and access each endpoints
- Use latest packages and libraries wherever applicable
- use schema validations and libraries for the same.


## Strategy

1. Write plan with success criteria for each phase to be checked off. Include project scaffolding, including .gitignore, and rigorous unit testing.
2. Execute the plan ensuring all critiera are met
3. Carry out extensive integration testing with Playwright or similar, fixing defects
4. Only complete when the MVP is finished and tested, with the server running and ready for the user

## Coding standards

1. Use latest versions of libraries and idiomatic approaches as of today
2. Keep it simple - NEVER over-engineer, ALWAYS simplify, NO unnecessary defensive programming. No extra features - focus on simplicity.
3. Be concise. IMPORTANT: no emojis in README