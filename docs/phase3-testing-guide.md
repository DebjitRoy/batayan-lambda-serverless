# Phase 3: acceptance testing

All automated Phase 3 release gates now pass, including login with a real backed-up user's known password. Automated local tests, the real AWS synthetic smoke test, and the legacy image audit pass. No production cutover or AWS backup import has been performed.

## Verified results

| Check | Result |
| --- | --- |
| Unit, migration, API/error and concurrency suites | 83 tests passed |
| Real local MongoDB reference comparisons | 32 tests passed |
| Restored-data HTTP acceptance | Passed against all 145 posts, 1,344 comments and 4 users |
| Post list latency | Local warm p95 approximately 0.52 seconds, concurrency 4; target 1 second |
| Catalog read capacity | Approximately 770 strong-read units per list; 3 internal scan pages |
| Confirmed expected list traffic | Under 1 request/minute; tested conservatively at 1 |
| Existing image availability | All 1,123 references accessible via public HTTPS HEAD |
| Actual AWS smoke | Passed in account 523185248252, `us-east-1`; synthetic data only |
| AWS cleanup | Temporary stacks, tables, Lambdas, logs and exact S3 objects removed |
| Migrated-user login | Passed with the owner-supplied private credentials; original ID/role and invalid-password rejection verified |

The tests found and fixed two upload defects: missing post/section targets now return 404 before S3 side effects, and presigned uploads request the same public-read ACL as direct uploads. Real S3 tests confirmed both resulting URLs are readable in the current legacy bucket. Buckets that disable ACLs require a separate policy-based configuration; these tests do not change bucket ownership or access policies.

## Repeat the local checks

Use PowerShell from `D:\projects\batayan_serverless`. No AWS deployment is needed for this command.

1. Keep DynamoDB Local running in one terminal:

   ```powershell
   npm.cmd run db:local:start
   ```

   Skip starting another copy if port 8000 is already occupied by DynamoDB Local. This uses the installed `.local/dynamodb` files and bundled Java runtime when available. It is an in-memory database: stopping it clears local tables.

2. In another terminal, run:

   ```powershell
   npm.cmd run test:phase3
   ```

   This runs the 83-test regression suite, 32 MongoDB reference comparisons, restored-data HTTP acceptance, and TypeScript typecheck. The reference database contains synthetic text fixtures and is stopped afterward; MongoDB remains a development-only dependency. The first run may download its local reference binary into `.local/mongodb`.

   HTTP acceptance creates a fresh `acceptance-<timestamp>` stage, restores the pinned backups, starts Serverless Offline on ports 4200/4202, checks the APIs, and stops only its own API process afterward. The usual dev server on port 4100 and its tables are left alone. Keep ports 4200 and 4202 free.

   Expected end: `Phase 3 local checks passed`. A `Pending: known migrated-user login` message means the local functionality passed but that final acceptance check has not run. Synthetic test users, posts, comments, series and jobs are removed. Restored local tables remain for inspection; post visits intentionally performed by the tests remain incremented and are accounted for in the content comparison.

3. Check packaging:

   ```powershell
   npm.cmd run build
   ```

   Expected: `Service packaged`. This does not deploy resources. Source backups, reports, `.env`, local runtimes and test tooling are excluded from the Lambda archive.

## Close the real migrated-user login check

Put the following values privately in the ignored `.env` file:

```dotenv
MIGRATION_TEST_EMAIL=<email of one of the four backed-up users>
MIGRATION_TEST_PASSWORD=<that user's known password>
MIGRATION_EXPECTED_LIST_REQUESTS_PER_MINUTE=1
```

Quote `.env` values containing `#` or whitespace. Do not commit these values or paste the password into chat. This test does not reset the password or alter the stored hash.

Run:

```powershell
npm.cmd run test:acceptance
npm.cmd run test:release-gates
```

The acceptance script creates a new isolated restoration and checks successful login, the original user ID/role, invalid-password 401, and absence of password/hash/token values in responses and captured server logs. Expected report field: `migratedLogin: passed`. If the password is unknown, choose an account-recovery approach before cutover rather than substituting a synthetic account for this check.

`test:release-gates` reads the current reports. Exit code 0 means every automated gate is green; exit code 1 lists pending or failed checks. The latest verified run passed every automated gate, including the real migrated-user login. Rerun the relevant tests after code, dependencies, backup inputs, or AWS configuration change; these reports are test snapshots.

If login reports `HTTP_401_EXPECTED_200`, the configured credential pair was rejected. Use the application's password that matches the June 3 backup; a password changed afterward will not match the recovered hash. Check `.env` quoting for `#` or whitespace. The acceptance suite continues independent HTTP and capacity tests after a login failure, while keeping the login gate failed and its exit code nonzero. It never prints the password or alters a backup hash to force a pass.

If HTTP, latency, and capacity all become pending together, inspect `migration-reports/phase3-local.json`: a startup failure or an older fail-fast report may have stopped before those measurements. Run `test:acceptance` to refresh the report after fixing the stated failure.

## Repeat the existing-image audit

```powershell
npm.cmd run test:images
```

This sends backup-derived filenames to the configured public S3 URL using read-only HEAD requests. The owner explicitly approved this audit. Expected: `1123 references, 1123 unique keys, 1123 accessible, 0 unresolved`. No objects are rewritten. HTTP 403 is classified as inaccessible/unknown rather than proof that an object is missing. Non-200 results are recorded in the private report and cause a nonzero exit.

## Repeat the real AWS smoke test

```powershell
npm.cmd run test:aws -- --account-id 523185248252 --region us-east-1 --bucket bengali-blog-static-uploads
```

This is a cloud test, separate from `test:phase3`. It verifies the caller account, uploads a code-only ZIP to a unique `migration-tests/batayan-phase3-<timestamp>/` prefix, and creates a temporary CloudFormation stack with two Lambdas, a scoped execution role, five provisioned 1/1-capacity tables, and log groups. It uses synthetic credentials and records; no backed-up users, posts, comments or private account credentials are uploaded. Paid OpenAI calls remain disabled.

It tests real Lambda authentication and DynamoDB transactions/counters, direct and presigned S3 uploads, readable image URLs, and asynchronous worker invocation/polling. The worker's expected missing-key failure proves the dispatch/persistence path without paid model calls. Mocked local tests separately cover successful summary/grammar results and malformed/upstream failures.

The temporary role can access only its five tables, its S3 prefix, its worker and its logs. Cleanup deletes the owned stack and the exact uploaded object versions. Expected final output: `AWS smoke: passed; cleanup=complete`. If cleanup fails, the report records the stack name/prefix and the command exits nonzero; remove only those test resources before rerunning. Existing service resources are not updated.

The smoke-test allocation is $0.25 within the owner's $5 monthly project budget; this is a planning allowance, not an AWS billing cutoff. The successful smoke run lasted about two minutes; both the initial diagnostic run and the successful run were cleaned up. Repeated cloud runs incur additional usage. Account-wide spending alerts still require the configured budget's production deployment.

## Capacity and performance limits

The full catalog list scans approximately 770 strong-read units. At the updated confirmed upper bound of 1 list/minute, that component averages approximately `770 × 1 / 60 = 12.83 RCU`, below the revised planned 15 RCU for posts. This leaves about 2.17 RCU for other reads; it is not a guarantee that all traffic fits, because detail reads, series hydration and administrative activity share capacity. Visit counters also consume write capacity based on full post size.

The revised production allocation totals 22 read and 22 write units across the five tables. This changes infrastructure configuration only; it has not been deployed.

The local p95 target passed. Local DynamoDB has different throttling behavior from provisioned AWS DynamoDB; the synthetic AWS smoke does not establish full-catalog production p95 or account-wide cost. Monitor real consumed capacity, throttles and latency during controlled staging/cutover. If traffic exceeds the declared rate, revisit the scan design or capacity budget before increasing allocation. See [AWS read/write capacity calculations](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html).

## Private reports and release prerequisites

- `migration-reports/phase3-local.json`: HTTP checks, timings, capacity estimate and migrated login status.
- `migration-reports/phase3-parity.json`: MongoDB reference test results.
- `migration-reports/phase3-images.json`: per-key public image availability.
- `migration-reports/phase3-aws.json`: AWS checks, failure details if any, and cleanup status.

Keep reports private and outside Git. Before Phase 4, rerun the automated gates as needed and close the remaining recovery prerequisites in `recovery-record.md`: off-device backup, acceptance of the June 3 recovery point, and production mapping/account/budget review. Existing npm audit findings also remain separate release risks. Green functional tests do not establish recovery of post-backup changes or resolve those dependency findings.
