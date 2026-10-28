# Phase 2: validation, import, and verification

The importer restores the three pinned June 3, 2026 exports directly into DynamoDB. It never uses application APIs, invokes workers, uploads images, or rehashes passwords. Phase 2 has been rehearsed locally; no AWS import or deployment has been performed.

## Completed rehearsal

Local stage: `rehearsal-1793143176918`. Its tables are named `batayan-serverless-rehearsal-1793143176918-<collection>` and are separate from the API's dev tables. The verified local tables have been retained for inspection. Because DynamoDB Local is running in memory, stopping it discards these tables; the original files and reports remain on disk.

| Check | Result |
| --- | --- |
| Source validation | 4 users, 145 posts, 1,344 comments; zero issues |
| Controlled interruption | Stopped after 37 successful writes |
| Resume | 1,456 imported, 37 matched; complete |
| Identical rerun | Zero imported, 1,493 matched |
| Consistent-read verification | All 1,493 records matched; zero missing or extras |
| Edited-record test | Refused before any import writes; edited value preserved |
| Unexpected-job test | Refused before any import writes |

Private manifests are under `migration-reports/rehearsal-1793143176918/`; the initial standalone preflight report is `migration-reports/phase2-validation.json`. Each record has a canonical SHA-256 hash, conservative DynamoDB item-size estimate, and outcome. Reports contain no record payloads, password hashes, or email addresses. The report folder is ignored by Git and access-restricted on Windows; on other platforms it is created with private directory/file modes.

## Preserve historical values

- Keep post, comment, user, and all 1,924 section IDs unchanged.
- Convert Extended JSON dates from epoch milliseconds or timezone-qualified ISO strings into UTC ISO strings. Invalid dates and unknown wrappers are rejected.
- Preserve Bengali text, whitespace, explicit `null` section fields, array order, counters, image filenames, legacy `user` roles, and bcrypt hashes.
- Preserve the empty titles on 1,343 historical comments. This is an import-only compatibility rule; new-comment API validation remains unchanged.
- Fill missing historical status with `published`, missing `additionalInfo`/`reply` with empty strings, and apply other existing defaults only to absent fields. Remove top-level MongoDB `__v` metadata.
- Canonicalize user email using trim/lowercase and reject collisions. Any normalization is audited using user ID, source index, and before/after hashes; the immutable source retains the original value. None of the four supplied addresses required normalization.
- Refuse series references without a supplied series backup. The supplied posts have no series references; series/job tables must remain empty.

Source filenames, counts, and SHA-256 values are pinned in `scripts/migration/backup.ts`. A changed source file is a validation failure. Supporting a newer backup requires reviewing its inventory and updating those pins deliberately.

## Commands

Use Node.js 22+, run commands from the repository root, and keep DynamoDB Local running on port 8000. In PowerShell use `npm.cmd` so flags reach the script. The CLI does not read `.env`; all target selection is explicit.

Validate without any AWS/database calls:

```powershell
npm.cmd run migration:validate -- --source src/migration --out migration-reports/validation.json
```

Repeat the complete local rehearsal with newly named isolated tables:

```powershell
npm.cmd run migration:rehearse
```

This command creates a unique local stage, validates the real files, exercises cancellation/resume/rerun, verifies the data, and tests conflict/extra detection in separate temporary tables. It cleans up the conflict-test tables and retains the verified rehearsal stage. It cannot select AWS or the API's dev/prod tables.

For an existing isolated local target, use its printed stage name:

```powershell
npm.cmd run migration:import -- --source src/migration --account-id local --region us-east-1 --stage rehearsal-1793143176918 --endpoint http://127.0.0.1:8000 --out migration-reports/manual-import.json
npm.cmd run migration:verify -- --source src/migration --account-id local --region us-east-1 --stage rehearsal-1793143176918 --endpoint http://127.0.0.1:8000 --out migration-reports/manual-verification.json
```

Expected rerun: `imported=0, matched=1493, issues=0, missing=0, extras=0`. Expected verification: `matched=1493, issues=0, missing=0, extras=0`. These stage-specific commands work only while that local database/table set still exists. The importer does not create missing tables.

Use `npm.cmd run migration:import -- --help` for argument details. Store distinct manifests for each operational run rather than overwriting audit history.

## Resume and conflict handling

All three files are read and validated before target access. The importer checks account identity and all five table schemas/statuses before inspecting data or writing. Preflight scans compare existing target records with the expected canonical data: missing rows are allowed during import, but edits and unexpected rows stop the run before writes.

Existing identical rows are skipped. Missing rows are written in user/post/comment order with an `attribute_not_exists` condition. If a record appears between preflight and put, a strongly consistent get determines whether it matches; a mismatch stops the run. There is no overwrite/delete mode. A final comparison confirms every imported record and checks for extras across all five tables. For API reads that increment visits, even opening a post during this comparison changes the expected data.

Ctrl+C requests cancellation. The in-flight operation can finish before cancellation is observed; a report is checkpointed every 25 processed records and at completion/interruption. An abrupt termination can leave the report behind the database. Rerun the same source/target with a new report filename: resume derives its state from consistent target reads and conditional puts, not from trusting an old checkpoint. Process exit codes are 0 for success, 1 for rejection/failure, and 130 for graceful interruption.

For a conflict, inspect the issue code and field path in the private report. Preserve the changed target data and determine its provenance; do not edit the original backup or delete live changes to force a match. An isolated, freshly provisioned replacement target is the safe way to restart a recovery that needs a different mapping.

## AWS staging requirements

AWS execution remains a later staging/cutover action. Before running it, verify recovery-point acceptance, the off-device backup, target account/Region, credentials, capacity budget, and the maintenance window. Stop all writers, including background jobs and post-detail requests that increment visits. Consistent scans are not an atomic table snapshot.

Omit `--endpoint` for AWS; provide the actual 12-digit `--account-id`, Region, and stage. The CLI ignores any ambient `DYNAMODB_ENDPOINT`, calls STS `GetCallerIdentity`, and validates each table ARN against the requested account/Region and computed name. It rejects on-demand AWS targets because this runbook budgets provisioned capacity. It never creates AWS tables.

The importer identity needs `sts:GetCallerIdentity` and `dynamodb:DescribeTable`, `Scan`, `GetItem`, and `PutItem` on the five target table ARNs. It does not need update, delete, S3, OpenAI, or Lambda-invoke privileges. Configure an AWS profile or temporary role credentials outside source control.

AWS writes are paced using the conservative item-size estimate rounded up to 1 KB units, capped at 80% of each table's declared write capacity. `--write-units-per-second` can lower that rate. Scan pages request consumed-capacity information and are paced against read capacity. SDK standard retries use jittered backoff with at most five attempts; an exhausted error stops the run and is reported. Local rehearsal uses faster local-only limits. These limits control importer traffic; they do not cap the AWS bill or account for unrelated activity.

Item sizing includes UTF-8 attribute names/values, nested container/element overhead, and a conservative upper bound for numbers. Records exceeding 400 KB are rejected before any import. The largest transformed record in this backup has an estimated upper-bound size of 83,703 bytes. See [AWS item-size calculations](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/CapacityUnitCalculations.html) and [conditional puts](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_PutItem.html).

## Next gate

Phase 3 covers broader API acceptance using restored records, real S3/worker/IAM staging checks, known-user login, series text-search parity, and performance/cost measurements. Successful local migration is not evidence of production S3 access, recovery of changes after June 3, or a working original user's password.
