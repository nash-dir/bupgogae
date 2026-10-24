# Ingestion integrity repair — 2026-10-24

Status: local repair verified; production recovery requires a fully successful
normal crawl, trusted state publication, public publication and readback. Do not
use this document alone as evidence of operational recovery.

## Confirmed starting point

The 2026-10-21 operational run 39606670653 already applied 349026, 242327 and
617561 and published 161,133 keys. Diagnostic 39617168275 subsequently passed.
These three recoveries must not be reapplied. The owner-excluded 623129 and the
physical quarantine inventory remain unchanged.

The 2026-10-22/23 scheduled runs 39784192867 and 39958517111 failed without
publishing public outputs. The 22 October artifacts have expired. On 24 October,
read-only diagnostic 40049321119 authenticated the 23 October resume artifact and
reported master SHA-256
`9c86fe8e4b6bfbcb43c225676527cb1145aff6cca42487808d627063cde62fba`,
212,541 raw rows, 161,162 candidate keys, and exactly two reference differences.
Court-code mappings already in the reference had not changed.

## Independent failures

| Serial | Identity | Finding | Treatment |
| --- | --- | --- | --- |
| 192184 | 2013노1, 209(병합) | List returns only 2013노1; exact official detail retains both members | Pinned full-detail replay; no member deletion |
| 623971 | 2023가단13936(본소), 2024가단4762(반소) | List omits counterclaim | Pinned replay of unchanged reviewed identity |
| 624491 | 2020가합571614(본소), 2022가합521507(반소) | List omits counterclaim | Same |
| 614353 | 2024나11658(본소), 2024나11665(반소) | List omits counterclaim | Same |
| 616625 | 2023고합1098, 2024고합41, 2024고합116 | List omits merged members; detail uses mixed-year shorthand | Exact reviewed metadata/body and explicit canonical record; no new global shorthand rule |
| 69909 | 2004가단14869 | Reference/raw says 2004-10-28; current official list/detail says 2004-10-07 | Owner explicitly authorized source-verified metadata migration |
| 185122 | 2017노5 | Reference/raw uses 서울고등법원/code 10; current list/detail identifies 춘천재판부/code 164 | Same; retain every existing court-code assignment |

The first five failures are an incomplete reviewed replay policy, not evidence
that the original merged members disappeared. Fresh collection also needs the
same proof-backed resolver, rather than relying on preexisting provenance rows.
The last two are current upstream metadata differences from the archived raw and
reference; a parser retry cannot reconcile them. Their precise upstream change
date is not established by the retained evidence.

The trusted finalizer calls `_verify_incremental_health`, which calls the same
full `export_core()` reference-preservation gate, before creating an R2 client or
uploading a generation. The failed resume state's demonstrated reference conflict
therefore also blocks trusted state publication. Previously the finalizer reduced
all such errors to `ValueError`; it now reports only an explicit allowlist of safe
integrity enums, never arbitrary exception text. No R2 permission relaxation or
upload-validation bypass is introduced.

## Source proofs

Official detail metadata and the complete original bodies were retrieved on
2026-10-24. Public-only gzip fixtures contain metadata/body without API keys,
request URLs or administrative fields. Full body SHA-256 values:

| Serial | SHA-256 |
| --- | --- |
| 192184 | `323c069c5ca1794426b4500bbd90a90938a43262802a29a60c5c0d07c80c8f9e` |
| 623971 | `93723699374c3f29ef1b7fdd60b730b129426c855cd0ffe2c2960721f11ca240` |
| 624491 | `4ac2bd5087c20ebe4f349545ed7f0763edc860a3e0f7ce7e9c7fca5bcd426565` |
| 614353 | `93788be226834ecc35a98c2013942b314e14dd14d3c4e3c178427d775dcd367f` |
| 616625 | `96989c0eca9c80a966be6e48b28ae42858cf10eaf2121a0dc515875e578c562a` |
| 69909 | `770ce150d43aacabfec4eb596dcb58a3602ff030c127a0ea25ab8a336a9aa561` |
| 185122 | `4e42d9a962bb1fa3fa4d7057a79bb451c726c8fcfbc12fb5f6f351285b9fe63a` |

Proof entry dictionaries bind every current list field, exact detail metadata,
archived identity, canonical identity and body digest. Future source drift fails
closed. The metadata migration fetches and verifies both current lists and both
originals before any writable connection is opened.

## Explicit metadata migration

`pipeline/apply_metadata_corrections.py --data-dir DIR` is review-only;
`--apply` atomically applies only 69909 and 185122. It starts from a healthy export,
not the corrupt failed-run snapshot. Existing raw rows, inserted_at values,
quarantine rows, and all unaffected reference records remain intact. New serving
receipts expose the verified corrected date/court. The old reference payload,
review JSON, before/after hashes, corrections dictionary digest and full raw
inventory digest remain in `reference_metadata_migrations` for audit/rollback.
Existing title receipts retain their exact raw/title bindings and are rebound to
the new reference hash inside the same transaction. Full export must pass before
commit; any failure rolls back reference and receipt writes. Repeat application
revalidates source proofs and performs no recovery writes.

The manual `correct_reviewed_metadata` workflow input defaults to false, is
restricted to the API-only crawl job, and does not introduce R2 credentials there.
The ordinary full crawl and existing trusted/public publishing gates still run.
Use `recover_reviewed_historical=false`; the 21 October recoveries are complete.

## Local verification boundary

An older local copy, not the latest production state, was used to replay all
three captured failed months (509, 355 and 425 source rows). With the two reviewed
metadata changes applied, all three ranges passed, full export passed, no
post-migration reference differences remained, and the physical quarantine count
remained 49,662. The migration itself left the full raw inventory digest unchanged;
a repeat migration wrote nothing. These results do not establish production
recovery or the completeness of a normal daily run.

The read-only state diagnostic also supports the authenticated input artifact,
allowing the healthy pre-crawl state and failed post-crawl state to be distinguished
without adding R2/API credentials or rewriting either database.

Private execution evidence and source captures are ignored under
`backfill/2026-10-24-integrity/`. Extension changes from the preceding adapter task
are outside this repair and must not be included in its commit. R2 adapters.json
for older extension clients remains untouched.
