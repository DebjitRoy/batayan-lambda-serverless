## How the Lambda worker works for the grammar check flow

### 1. User submits a request
- The API route `createGrammerCheck` is called.
- It validates the request body using `grammerCheckSchema`.
- It creates a new job record in MongoDB with:
  - `sections`
  - `status: "pending"`
  - `updatedAt`

### 2. The worker is invoked asynchronously
- `createGrammerCheck` calls `invokeWorker(jobId)`:
  - This uses `@aws-sdk/client-lambda`
  - It sends an `InvokeCommand` with `InvocationType: "Event"`
- `InvocationType: "Event"` means:
  - the call returns immediately
  - Lambda runs the target function in the background
  - the API request does not wait for the OpenAI processing to finish

### 3. The worker function processes the job
- The worker entry point is `processGrammerCheck(event)`
- It:
  - loads the job from MongoDB using `jobId`
  - updates job status to `processing`
  - builds the OpenAI prompt from `job.sections`
  - calls OpenAI via `client.chat.completions.create(...)`
  - parses and validates the JSON response
  - stores the result back into MongoDB
  - updates job status to `completed`

### 4. Failure handling
- If the worker cannot invoke OpenAI or parse the response:
  - it updates the job status to `failed`
  - writes the error text into the job record
- This is safer than letting the original HTTP request fail while OpenAI is still running

### Why this is useful for long-running tasks
- Grammar checking can be slow or unpredictable
- The HTTP request remains fast because it only:
  - creates a job
  - triggers the worker
- The actual work is done separately by the Lambda worker
- The client can poll `getGrammerCheck(jobId)` later to get final status/result

### Summary of the lifecycle
1. `createGrammerCheck` creates a pending job
2. it invokes the worker Lambda asynchronously
3. the worker loads the job and marks it processing
4. the worker sends the job to OpenAI
5. the worker saves the final suggestions and marks the job completed

This pattern decouples request handling from the slow OpenAI call, making the API responsive and more robust for long-running grammar checks.