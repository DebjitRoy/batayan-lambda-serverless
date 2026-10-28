# MongoDB backup to DynamoDB migration plan

Prepared: 27 October 2026. Updated after local phase 0/1 implementation. DynamoDB API code and infrastructure definitions are implemented; no AWS backup import or production deployment has been performed. Phase 3 used temporary synthetic AWS resources, now removed. See `recovery-record.md` for verification and pending operational inputs.

## 1. Recommended approach

Restore the supplied JSON exports into five DynamoDB Standard tables, then replace Mongoose persistence with AWS SDK v3 repositories while retaining the existing API Gateway routes, request validation, response shapes, IDs, and authentication behavior. Keep images in S3.

This is a recovery from backups. The original MongoDB is unavailable, so continuous replication and a final live database comparison are not possible. Records created or changed after the backups cannot be recovered from these files. Confirm the acceptable recovery point before production cutover; filenames alone do not establish when a backup was taken.

DynamoDB is suitable for this small blog, with one tradeoff: the existing arbitrary sorting, substring search, numbered pages, and exact totals need application-side processing. Start with paginated table scans for post lists and series search. Measure the resulting capacity use before production; do not claim that every request will remain free at any traffic level.

## 2. Backup inventory and findings

Read-only inspection of `src/migration/` found JSON arrays containing MongoDB Extended JSON, including `{"$oid":"..."}` and `{"$date":{"$numberLong":"..."}}`.

| File | Records | File bytes | Largest source record, compact JSON bytes |
| --- | ---: | ---: | ---: |
| `batayan_posts060326.json` | 145 | 3,353,520 | 86,959 |
| `batayan_comments_060326.json` | 1,344 | 653,586 | 1,565 |
| `batayan_users.json` | 4 | 1,243 | 254 |
| Total | 1,493 | 4,008,349 | |

Observed findings:

- All 1,344 comments reference a backed-up post; post IDs are unique.
- Posts contain 1,924 embedded sections, all with section IDs. Preserve their order and IDs.
- Post types: 68 travel, 30 books, 42 miscl, 5 guest.
- All 145 posts lack `status` and `series`. The current list handler treats missing status as published when filtering for published posts. Import these historical posts as `published`; new posts must continue to default to `draft`.
- Four users have role `user`, outside the current `admin | author | guest` schema. Preserve this legacy value in imported users, public login responses, and JWTs; permit it in the stored-user type without adding it to new registration choices. Do not silently promote accounts. Confirm any later role changes separately.
- All four password values match a bcrypt hash prefix; this does not prove that a known password works. Normalized user emails have no duplicates. Copy hashes unchanged and verify login with a known password during acceptance testing.
- Fourteen posts lack `additionalInfo`; all comments lack `reply`. Apply the current empty-string defaults.
- Observed post creation dates span 6 July 2020 through 19 May 2026; comment creation dates span 16 July 2020 through 24 May 2026. These are record dates, not proof of export freshness.
- No inspected text exceeds the current title, gist, section caption/header, or comment length limits; no post has a negative visit/like counter. The importer must still perform full validation.
- There are 1,123 nonempty image references across hero, gallery, and section images; none are absolute HTTP URLs. These are references, not image backups or evidence of unique existing objects. Check them against the configured S3/public base path.
- No series or background-job export was supplied. Existing series/job history cannot be recovered from these files. Provision empty tables so those APIs can function for new records. The older `GrammerCheckJobModel` is not used by the currently routed handlers; do not invent historical jobs.

Source SHA-256 checksums (verify again immediately before import):

```text
batayan_posts060326.json      5304347463a67f96fdb33dae275e06e522546923c6f22f013ba64acfcb2da137
batayan_comments_060326.json  4fd15213c60e98e7723160eb38286400ee24eed1cb603d419095009f51568b63
batayan_users.json           3bbefc4902f1a0d626655ebe1c87066eb8a0392cb31cd9dbd4e63771597d5960
```

## 3. Table design and cost controls

Use stage-specific names such as `batayan-prod-posts`. No secondary indexes are required initially.

| Table | Partition key | Sort key | Storage/access |
| --- | --- | --- | --- |
| Posts | `_id` string | None | Entire post including ordered sections; direct get/update/delete; scan for lists and series hydration |
| Comments | `post` string | `_id` string | Query all comments for a post; direct get/update/delete with both IDs |
| Users | `email` string | None | Canonical email lookup and conditional registration; retain original `_id`, bcrypt `password`, role, name, date |
| Series | `seriesId` string | `recordKey` string | `META` contains series data including original `_id`; `PART#<part>` reserves a part and points to a post |
| Jobs | `_id` string | None | Summary/grammar job data, status, result, error, and timestamps; get by job ID |

Internal key/lock/version attributes must never leak into public JSON. For users, use exactly the same canonicalization in import, registration, and login (trim and lowercase); retain an audit of any transformed address in a private migration report. Reject collisions before writing.

For series membership, use transactions to reserve/release part keys, update the post, and maintain a `memberCount` on `META`. Delete a series only with a conditional `memberCount = 0` check. Conditions must require the series to exist. This prevents duplicate parts and deletion/assignment races without a GSI. Remove reservations and decrement the count when a post is moved or deleted. Historical import requires no reservations because no backed-up post has a series.

Suggested initial provisioned capacity, subject to staging measurement:

| Table | RCU | WCU |
| --- | ---: | ---: |
| Posts | 15 | 15 |
| Comments | 2 | 2 |
| Users | 1 | 1 |
| Series | 1 | 1 |
| Jobs | 3 | 3 |
| Total per deployed stage | 22 | 22 |

AWS currently lists a DynamoDB allowance of 25 GB of Standard storage and 25 provisioned RCUs plus 25 provisioned WCUs. On-demand request charges have a different billing model. Check eligibility and existing usage in the payer account and selected Region; include other tables, indexes, and concurrent stages in the allowance calculation. [AWS DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/)

The backup footprint is small, but provisioned capacity is charged by allocation. Do not deploy this allocation simultaneously to dev and production expecting both to fit. Use DynamoDB Local for routine development, or smaller temporary staging allocations. Disable automatic capacity increases initially; handle throttling with bounded retries, and monitor it. Keep one Region and no global tables, DAX, or OpenSearch for this migration.

Use current AWS Billing information for the account: newer Free account plans have a limited lifetime/credit balance. A temporary credit is not a durable operating budget. [AWS Free Tier plans](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)

Create billing alerts for a small agreed budget and monitor consumed capacity, throttling, Lambda errors, latency, and log retention. Budget alerts do not stop spending. S3, API Gateway, Lambda, CloudFront, logs, OpenAI calls, optional backups/PITR, and data transfer have separate costs.

Large posts make reads and counter updates more expensive: provisioned writes are sized in 1 KB units, strongly consistent reads in 4 KB units; transactions cost more. An atomic visit increment is billed using item size even though only one number changes. Measure post-detail traffic as well as scans. Source JSON byte sizes are not exact DynamoDB item sizes: validate transformed items against the 400 KB limit, including UTF-8 attribute names, nested data, and internal metadata. [DynamoDB constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)

## 4. Preserve the API contract

Use `serverless.yml` and handlers as the contract baseline; the README omits some current behavior. Add characterization fixtures before replacing persistence. Do not introduce cursor-only public pagination or rename `/api/grammer-check` during this migration.

| Current route(s) | Required DynamoDB behavior |
| --- | --- |
| `POST /api/auth/register`, `/api/auth/login` | Conditional user put ensures unique email and returns 409 on conflict. Login reads by email and verifies the unchanged bcrypt hash. Preserve `{user:{id,name,email,role,createdAt},token}`, JWT subject/claims, and 401 behavior. Never return password hashes. |
| `GET /api/posts` | Preserve `search`, `expanded`, `status`, `sortBy`, `sortOrder`, `page`, `limit`, and `{items,page,limit,total,totalPages,expanded}`. |
| `GET /api/posts/{postId}` | Conditional atomic increment of `visited`; return the updated, hydrated post; nonexistent IDs must return 404 without creating an item. |
| `POST /api/posts`, `PUT /api/posts/{postId}` | Preserve defaults, validation, partial updates, series checks, generated section IDs, authentication, and job-ID response fields. Creation attempts AI jobs for nonempty content under existing rules; updates do so when `aiRequired` is true. |
| `PUT /api/posts/{postId}/status` | Update only status with existence condition and return hydrated post. |
| `DELETE /api/posts/{postId}` | Preserve `{deleted:true,id}` and 404. Current code does not cascade comments; retain that behavior and release any series reservation atomically. |
| `PUT /api/posts/{postId}/upload`, `/api/posts/{postId}/sectionupload/{sectionId}` | Keep S3 upload/presigned URL flow and response. Current handlers persist filenames (`photo_<postId>...`), not the returned absolute URL. Preserve this convention and locate sections by their existing `_id`. |
| `GET/POST /api/posts/{postId}/comments` | Check parent existence as today; return `{items}` sorted by `createdAt` descending or create with 201. Query every DynamoDB page before returning the unpaginated public list. |
| `GET/PUT/DELETE /api/posts/{postId}/comments/{commentId}` | Use the combined post/comment key so a comment cannot be accessed under another post. Preserve status codes and mutation responses. |
| `PUT /api/posts/{postId}/comments/{commentId}/reply` | Authenticated reply update with the existing validation and missing-comment response. |
| `GET/POST /api/series`, `GET/PUT/DELETE /api/series/{seriesId}` | Scan only `META` records for lists, preserve filters/pagination, and hydrate sorted member posts and totals. Enforce part uniqueness and the nonempty-series deletion conflict. |
| `POST /api/summary`, `POST /api/grammer-check` | Persist new jobs, invoke the existing Lambda worker asynchronously, return 202 and current job IDs/status. |
| `GET /api/grammer-check/{jobId}`, `GET /api/worker/{jobId}` | Preserve authenticated job lookup, `jobId`/`workId` aliases, null result/error handling, and timestamps. Migrate `processBackgroundJob` persistence too. |

Post list algorithm:

1. Read all post scan pages using `LastEvaluatedKey`; do not mistake DynamoDB's internal page limit for the public `limit`.
2. Apply the existing case-insensitive **literal substring** match to each `searchBy` element. Post search does not currently search title/gist despite the Mongoose text index.
3. Apply existing status behavior (including missing-as-published for legacy fixtures) and `expanded=false` series behavior: standalone posts and first parts only. No implicit published-only filter currently exists.
4. Sort the complete matching set by the allowed field (`createdAt`, `title`, `visited`, `liked`), defaulting to createdAt descending. Compare numeric counters numerically and dates chronologically. Verify Bengali/English title ordering against the MongoDB baseline; document a deterministic `_id` tie-break because existing equal-key order is unspecified.
5. Calculate totals before slicing the numbered page, then hydrate series using all relevant posts and series metadata.

Scans are intentionally acceptable only for the small initial catalog. They read in 1 MB pages, and filters/projections do not eliminate the underlying scan read cost. Strongly consistent scans still do not provide a transactionally frozen table snapshot. Measure latency and reads at realistic concurrency; agree an initial p95 target of 1 second for list requests and revisit the design if it fails. A future catalog/index redesign must preserve the public contract. [AWS scan behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html)

Series list search currently uses MongoDB `$text` over title, description, and tags. A substring search is not equivalent. Implement and test the MongoDB default text-search semantics used by clients (tokenization/stemming, phrases, exclusions, and OR terms), using a local MongoDB fixture as reference. If exact semantics cannot be reproduced, record and obtain acceptance of the specific difference before claiming compatibility; series search parity is a release gate even though its initial table is empty.

Preserve current authorization boundaries: several comment mutations are public, whereas reply and post/series mutations require a bearer token. Any permission redesign is separate scope. Preserve the existing JWT secret to keep valid tokens usable; if unavailable, configure a new secret and require login again.

## 5. Transformation and import rules

Implement a standalone TypeScript importer; do not send backups through `POST /api/posts`, which creates new IDs and may invoke paid AI jobs.

| Source | Target rule |
| --- | --- |
| `_id.$oid`, comment `post.$oid`, section `_id.$oid` | Keep the exact 24-character hexadecimal ID as a string. No UUID reassignment. |
| `createdAt.$date.$numberLong` | Parse epoch **milliseconds**, validate the date, and emit UTC ISO 8601. Also support the Extended JSON ISO `$date` form. Never use import time as a replacement. |
| `content`, `gallery`, `searchBy` | Preserve array order and Unicode, including Bengali, punctuation, whitespace, and newlines. Use DynamoDB lists, not sets. |
| Missing defaults | `additionalInfo: ""`, comment `reply: ""`; historical post `status: "published"`. Preserve all existing counters, filenames, and values. |
| User password/role | Copy bcrypt hash byte-for-byte; preserve legacy `user` role. Never rehash an existing hash. |
| `__v` | Remove MongoDB version metadata from canonical storage; log the intentional removal in the mapping manifest. If a known consumer needs it, reproduce it only in the response serializer. |

Validate imported documents with a dedicated schema that accepts IDs/dates and legacy roles. The create-post request schema is unsuitable: it can strip section IDs and apply new-record defaults. Reject unknown Extended JSON wrappers instead of silently dropping data. Fail preflight on duplicate entity IDs, duplicate comment composite keys, duplicate section IDs within a post, invalid dates/counters, unresolved references, or oversized items. Produce a private rejection report with record IDs and reasons; never silently skip records or truncate text.

For this dataset, use sequential/rate-limited conditional `PutItem` operations rather than a bulk service or DMS. On first write require key absence. On rerun, consistently read any existing target item: skip only if its canonical content matches the expected record; otherwise fail with a conflict. This permits interrupted imports to resume without overwriting API edits. A migration manifest records source checksums, transform version, target account/Region/stage, start/end time, expected/imported/matched/rejected counts, and canonical hashes. Exclude secrets from logs and reports.

If later switched to `BatchWriteItem`, its limit is 25 operations/16 MB per request, partial failures require retrying `UnprocessedItems` with backoff, and it does not support conditional writes. Restrict that alternative to an isolated empty target with writes disabled; it is not a safe replacement for the conditional resume algorithm. [AWS BatchWriteItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchWriteItem.html)

## 6. Implementation phases and acceptance gates

Checkboxes distinguish completed local implementation from remaining operational work. Production validation and later migration phases remain open.

### Phase 0 — Preserve recovery inputs and contract

- [ ] Copy the three original backups to protected storage and verify the checksums above. Keep one independent copy; restrict user-backup access because it contains account data and password hashes.
- [x] Extend `.gitignore` for raw migration backups and generated reports before committing them; the supplied migration folder was untracked at inspection. Commit code/documentation only. Ignore rules alone cannot remove already tracked files or erase history.
- [ ] Record the recovery point, missing data expectations, image bucket access, known-login test account, AWS account/Region, and allowed operating budget.
- [x] Create redacted fixtures from source shapes. Characterize handler responses with mocked Mongoose or a temporary local MongoDB fixture, since the original database cannot be queried.

Local progress: original files have checksum-verified, access-restricted recovery copies. The independent off-device copy and external recovery inputs remain open in `recovery-record.md`.

Success: immutable inputs, documented mappings, route inventory, and reproducible contract fixtures exist.

### Phase 1 — Provision infrastructure and persistence

- [x] Add current compatible `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb`; lock dependency versions. Add a TypeScript importer runner only if needed. Do not broadly upgrade unrelated packages.
- [x] Add five `AWS::DynamoDB::Table` resources in `serverless.yml` with the keys/capacity above, Standard class, encryption, and `DeletionPolicy: Retain` plus `UpdateReplacePolicy: Retain`. Enable production deletion protection. Export table names.
- [x] Add `POSTS_TABLE`, `COMMENTS_TABLE`, `USERS_TABLE`, `SERIES_TABLE`, and `JOBS_TABLE`; support a local-only `DYNAMODB_ENDPOINT`. Reuse a document client across Lambda invocations and omit undefined values during marshalling.
- [x] Give runtime roles only required get/query/scan/put/update/delete/transaction access to these tables. Keep deployment and importer privileges separate; use IAM roles/profiles without static keys in source.
- [x] Add `src/db/dynamodb.ts`, small entity repositories, explicit response serializers, and stored entity types independent of Mongoose. Replace every routed handler's MongoDB dependency, including uploads and workers.
- [x] Replace Mongoose-based ID validation/generation with validation and generation that retain 24-hex IDs for posts, sections, comments, series, and jobs. Capture existing ID-validation behavior in tests before changing it.
- [x] Remove `MONGODB_URI` from `getEnv()` required variables and deployed environment after the replacement. Authentication and S3 helpers call `getEnv()` too; leaving this requirement would break them.
- [x] Use conditional updates to avoid upserting missing records. Use atomic counters and targeted update expressions; use an internal version condition for section-array read/modify/write so concurrent uploads/edits cannot lose changes.
- [x] Implement transactional series assignment/move/delete conditions. Claim pending jobs conditionally so duplicate worker delivery cannot overwrite completed results; retain current API status/response vocabulary.
- [x] Update `.env.example`, README setup/deployment instructions, and repository tests. Remove Mongoose and unused models only after all required paths work without MongoDB.

Success: all routes and the worker run with `MONGODB_URI` unset, table names/permissions resolve correctly, and no runtime Mongoose calls remain. DynamoDB transactions provide atomic multi-item changes; handle condition conflicts explicitly. [AWS transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

### Phase 2 — Build and rehearse the importer

- [x] Add `scripts/migrate-mongodb-to-dynamodb.ts` with `validate`, `import`, and `verify` modes; explicit account/Region/stage, source directory, and output manifest arguments. Validate target identity before writes.
- [x] Run validation without AWS writes; require 145 posts, 1,344 comments, 4 users, and zero unresolved rejects.
- [x] Import users, then posts, then comments into a clean local/staging target. Leave series/jobs empty. Rate-limit by item size and table capacity, not just item count; retry throttles with bounded exponential backoff and jitter.
- [x] Interrupt/resume the run and rerun it fully. Prove matching records are skipped, mismatches fail, and no AI workers/S3 uploads are invoked.
- [x] Verify all 1,493 records by canonical field comparison and per-record hashes, not merely approximate DynamoDB table `ItemCount`. Verify comment relationships, all section IDs/order, dates, counters, hashes, and image references. Use consistent reads while writers are stopped.

Completed locally: all 1,493 records verified in isolated stage `rehearsal-1793143176918`; interruption/resume, no-write rerun, conflict refusal, and extra-record refusal passed. See `phase2-migration-runbook.md` for commands and report locations. No AWS import was performed.

Success: two runs produce identical canonical data and an auditable manifest with zero omissions or conflicts. Confirm no extra records exist in the isolated target.

### Phase 3 — Automated and end-to-end verification

- [x] Unit-test Extended JSON conversions, defaults, legacy roles, Unicode preservation, item-size calculations, duplicate/orphan rejection, serializers, ID handling, retry/resume behavior, and conflict handling.
- [x] Retain and adapt existing Vitest tests; add handler/contract tests for every row in the API matrix, including status/error bodies and auth boundaries.
- [x] Run HTTP integration tests against Serverless Offline with DynamoDB Local, using Vitest/fetch or equivalent. Test >1 MB post scans, paginated comment queries, list totals/page boundaries, literal search punctuation/case/Bengali text, all sort orders, status filters, and expanded series lists.
- [x] Test concurrent visit increments, duplicate registration, series part reservations/moves/deletion, post/section edits, and duplicate worker delivery. Confirm no lost updates and no phantom upserts.
- [x] Test direct and presigned image uploads using an isolated S3 test prefix/bucket; confirm legacy image paths still resolve. Record missing objects rather than rewriting references blindly.
- [x] Exercise summary and grammar create/poll/worker success and failure with OpenAI mocked; perform one explicitly budgeted AWS staging smoke test for Lambda async invocation, IAM, S3, and DynamoDB behavior.
- [x] Confirm login with a known migrated user's password, invalid-password 401, unchanged public user ID/role, and absence of hashes in responses/logs. A hash prefix alone is insufficient evidence.
- [x] Run `npm test`, `npm run typecheck`, and `npm run build`. Measure representative list/detail concurrency and capacity; record pass/fail against the agreed latency and budget targets.

Local regressions: 83 passed; MongoDB reference comparisons: 32 passed. Restored-data HTTP tests and the real synthetic AWS smoke passed; all 1,123 image URLs were accessible. Typecheck and packaging pass. Local p95 is about 0.52 seconds; 770 scan read units at the updated owner-confirmed upper bound of 1 list/minute average about 12.83 RCU, below the revised 15 post RCU allocation. Full-catalog AWS latency/account costs still require monitoring. The known migrated-user login passed with the owner-updated private credentials; all seven automated release gates pass. Phase 3 automated acceptance is complete, with production cutover and its manual prerequisites remaining separate. See `phase3-testing-guide.md`.

Success: reproducible tests pass, staging parity is demonstrated, and missing images/history and any accepted search differences are recorded before release.

### Phase 4 — Production recovery and cutover

1. Preserve the current deployed configuration/artifact and API/CloudFront origin mapping. Announce a recovery window; pause API mutations, worker dispatch, and traffic that increments visits during import/verification. Without MongoDB access there is no reliable delta catch-up.
2. Provision production tables and deploy the DynamoDB implementation to a separate recovery stage/origin. Recheck total provisioned allocations across stages against the allowance before deployment. Keep it inaccessible to ordinary writers.
3. Revalidate the original file checksums, run the rehearsed importer, and perform a complete consistent-read canonical comparison. Require exactly the expected record counts and zero rejected/conflicting records. Capture visit counters before any detail GET smoke test changes them.
4. Verify migrated login, representative old post URLs/section IDs, comments/reply, draft/published/status flows, series, uploads, and background jobs. Use temporary test records and remove them before final count verification.
5. Switch the existing `/api/*` origin/custom-domain mapping to the recovery deployment, keeping frontend URLs and paths unchanged. Wait for the mapping/distribution deployment; invalidate relevant cached API responses if API caching is configured. Keep authenticated/mutating API traffic uncached.
6. Start the service, re-enable traffic/writes, and verify the public endpoints. Observe errors, throttles, capacity, latency, images, and worker failures through at least the first normal traffic period and review billing the next day.
7. Record the production manifest, endpoint, deployed revision, table names, test results, known recovery gaps, and recovery owner. Keep protected source backups after cutover; they are not a substitute for backing up new DynamoDB writes.

Success: the same public API URLs serve validated DynamoDB data, new changes persist, the server is running, and the recovery report is complete. This gate applies to the future migration implementation, not completion of this planning document.

## 7. Rollback and ongoing recovery

- Before public writes: if import or verification fails, keep the maintenance window active, correct the importer, and retry in a clean isolated target or safely resume. Do not overwrite conflicts to force success.
- After cutover: the old MongoDB application is not a working rollback target because its database is inaccessible. Roll back application code only to a known DynamoDB-compatible build. If no such build exists, place the service in maintenance while fixing forward.
- Never rerun the old backup import over a live table to roll back: that could erase new posts/comments and reset counters. Preserve post-cutover data first. Any table restore must target new tables, be reconciled with subsequent writes, and be verified before switching table configuration.
- Before enabling production writes, choose an affordable recovery method and recovery-point objective for new data. PITR/on-demand backups have separate charges; confirm availability and cost. Alternatively schedule protected application-level snapshots with a tested restore process and accept their larger recovery window. Avoid an unattended backup job that silently stops.
- Retained tables are deliberate protection; `serverless remove` must not be treated as database cleanup. Clean up only temporary stages/test resources after successful verification, accounting for retained table capacity charges.

## 8. Runbook commands to add during implementation

These proposed script commands do not exist yet. Implement and test them before using this runbook; use configured table names and an explicit target identity.

```powershell
# Existing checks
npm test
npm run typecheck
npm run build

# Proposed local/staging validation and migration interface
npm run migration:validate -- --source src/migration
npm run migration:import -- --source src/migration --stage recovery --region us-east-1 --account-id <target-account-id>
npm run migration:verify -- --source src/migration --stage recovery --region us-east-1 --account-id <target-account-id>

# Existing server/deployment entry points, after DynamoDB implementation
npm run dev
npm run deploy -- --stage recovery
```

Implementation is complete only when the phase gates pass. The outstanding operational inputs are backup freshness acceptance, the independent off-device copy, AWS allowance/budget confirmation, and the production origin mapping. None requires reconnecting to the lost MongoDB to begin the implementation.
