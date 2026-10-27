# Recovery implementation record

Updated 27 October 2026. This record distinguishes local preparation from production recovery.

## Recovery inputs

| Input | Recorded value |
| --- | --- |
| Backup date | **3 June 2026**, confirmed by the owner |
| Recovery-point acceptance | Pending: confirm loss of changes after the backups is acceptable |
| Monthly budget | **USD 5**, confirmed by the owner |
| Spending alerts | Infrastructure prepared for actual monthly account spending over $1, $2, $3, $4, and $5; recipient configured in the ignored local `.env` file |
| AWS account and Region | Target account unconfirmed; configuration defaults to `us-east-1` |
| Image bucket and access | Pending verification; filenames are retained |
| Known migrated-user password | Pending acceptance test; do not put the password in this document |
| Production origin mapping | Existing README documents CloudFront; current production configuration must be verified before cutover |

No AWS deployment, production import, or real spending alert has been performed. AWS budget notifications use delayed billing data, are not a hard spending cap, and do not guarantee immediate alerts at a dollar boundary. The configured thresholds cover $1 through the agreed $5 budget. Configure additional thresholds if the budget changes. The budget is account-wide, so it includes AWS services beyond this project. See [AWS budget notification behavior](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html).

## Preserved inputs

The three source files were copied to `.recovery/originals/` and verified against the SHA-256 values in the migration plan. The recovery directory is ignored by Git. On Windows, the preservation script restricts directory access to the executing identity and SYSTEM and grants that identity read-only access to the backup copies. It does not overwrite existing copies; differing checksums stop the operation. Original files in `src/migration/` remain unchanged.

Run `npm run recovery:preserve` to recheck. A second destination can be supplied with `npm run recovery:preserve -- <destination>`. **An independent off-device copy is still required**: the workspace recovery copy protects against editing mistakes, not disk loss. Use encrypted storage under the owner's control, then verify the same checksums. No external backup destination was supplied.

Raw exports and generated private reports are excluded by `.gitignore`. They contain user identifiers and password hashes; synthetic test fixtures contain no copied account records or real password hashes. Ignore rules do not erase previously committed data.

## Contract baseline and implementation

Before persistence replacement, two characterization tests passed against mocked Mongoose handlers: historical post list fields/numbered envelope and comment envelope/parent existence. Their expected shapes are retained in `tests/fixtures/legacy.ts` and the DynamoDB contract suite. Source routes and handler behavior, rather than the older README alone, established the endpoint inventory in the migration plan.

Phase 1 replaces MongoDB in all routed handlers and the asynchronous worker with five tables, IAM-scoped data access, explicit entities, public serializers, conditional updates, version-checked post writes, and transactional series membership. Imported users may retain the legacy `user` role; new registration choices are unchanged. New post statuses remain draft. ID generation/validation remains compatible with 24-hex public identifiers.

Tables use DynamoDB's default encryption with AWS owned keys, avoiding the additional KMS charges associated with selecting AWS managed/customer managed keys. See [AWS encryption options](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/EncryptionAtRest.html).

The live HTTP rehearsal exposed an existing Zod 4 issue: optional fields with defaults were being filled on partial updates. Update schemas now remove top-level create defaults, so changing a gist/title preserves omitted tags, content, counters, replies, and descriptions. Regression tests cover this correction.

Post list search remains a literal case-insensitive substring match over tags. Series search uses Snowball English stemming, stop words, phrases/exclusions, and Unicode tokenization. Representative search tests pass, but exhaustive MongoDB `$text` tokenizer parity has **not** been established against a real MongoDB fixture; this remains a phase 3 release gate. Equal sort keys now use an explicit `_id` tie-break; title ordering uses UTF-8 binary comparison, corresponding to MongoDB's default simple collation. A custom original collection collation, if any, cannot be inferred from the exports.

## Verification

- Baseline: 2 characterization tests passed before replacement.
- Current local verification: **31 tests passed**, including nine DynamoDB Local integration scenarios; `npm run typecheck` passed. Serverless packages for both dev and prod built successfully. The generated production template was checked for retained/protected tables, scoped IAM, table outputs, and the $1–$5 budget thresholds.
- Live HTTP smoke passed for authentication, post/status CRUD, list filtering, comment CRUD/reply, series membership/deletion checks, and actual asynchronous local worker dispatch/polling with paid AI disabled. Synthetic records were removed. The local API is available at `http://localhost:4100`, backed by in-memory DynamoDB Local on port 8000; local worker invocation uses port 4102.
- The deployment archive was inspected: raw backups, `.recovery`, `.local`, and environment files are absent. Explicit package exclusions also protect these paths from future packaging changes.
- The owner supplied the alert recipient, now saved as `BUDGET_ALERT_EMAIL` in the ignored local `.env` file. Production packaging is checked against that recipient; notifications remain inactive until production deployment.
- Integration uses synthetic data in temporary local tables and deletes those tables afterward. S3, Lambda invocation, and OpenAI are mocked; no paid AI calls or production writes occur.
- Production IAM, S3 object accessibility, migrated-user login, missing post-backup changes, and AWS capacity/latency costs remain staging/cutover checks.
- The existing dependency tree has npm audit findings (1 low, 3 moderate, 8 high, 1 critical on inspection), including existing OpenAI and development-tool dependencies. They are not introduced by importing the backup data. A separate dependency/security update is still needed; this change does not silently apply unrelated major SDK upgrades.

## Remaining phase 0 operations

Keep these open until the owner supplies or verifies the external inputs: independent off-device backup, recovery-point acceptance, AWS account/Region, image-bucket access, and known-user login availability. Local implementation can proceed without them; production recovery cannot be represented as verified yet.
