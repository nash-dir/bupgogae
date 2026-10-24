# Ingestion integrity repair — 2026-10-24

Status: production recovery verified on 2026-10-24 after normal complete
collection, trusted state/public publication, exact private/public readback and
both ordinary fixed-URL mirror checks. Final public verification exited zero at
03:48 UTC; no expected hash, URL or integrity gate was bypassed.

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
| 613299 | 2021나51458 | Full normal crawl: list says 대전고등법원청주재판부; official detail and existing reviewed record say 대전고등법원(청주) | Exact proof-backed replay; no existing value changes |
| 614417 | 2022노82 | Full normal crawl: 부산고등법원울산재판부 versus 부산고등법원(울산) | Same |
| 618471 | 2023고단1179, 2024고단1582(병합) | Full normal crawl: list omits second member; detail retains it | Same; preserve both members |
| 623981 | 2024누10023 | Full normal crawl: list omits (울산) prefix present in official detail case number | Same; retain existing 부산고등법원(울산) |
| 64808 | 2008도3090 | Full normal crawl: reference/raw says 2008-08-11; official list/detail says 2008-08-21 | Separately owner-approved metadata correction |
| 164098 | 2011나506 | Full normal crawl: reference/raw says 광주고등법원; official list/detail says 제주재판부 | Same |
| 176537 | 2014노268 | Full normal crawl: reference/raw says 부산고등법원; official list/detail says 창원재판부 | Same |

The five original replay failures and four additional replay conflicts expose an
incomplete reviewed replay policy, not removed merged members. Fresh collection also needs the
same proof-backed resolver, rather than relying on preexisting provenance rows.
69909, 185122, 64808, 164098 and 176537 have differences between current official
metadata and the archived raw/reference; a parser retry cannot reconcile them.
The retained raw/reference proves the mismatch, but without an older official
list/detail capture it does not establish whether the government edited the
source or the archived metadata was already wrong. The current parser reproduces
the current official fields; no date/court guessing is used to reconcile them.

The first operational attempt, 40052603491, passed all three incident months but
also exposed the four additional replay conflicts above in its normal scheduled
2022-05, 2023-08 and 2024-11 windows. Each was independently compared with current
official detail and existing reviewed provenance before adding an exact replay.
The normal crawl remains mandatory; passing only the original incident windows
does not satisfy recovery.

Read-only diagnostic 40054878787 of that complete run identified exactly the
three additional metadata differences above, with no court-code map changes.
The five-entry correction procedure is explicitly approved by the owner. The
first two-entry attempt never reached private state or public publication;
40054036296 was cancelled before publication after the new conflict was found.
The final migration must start from healthy trusted input, never either failed
resume artifact. Historical recovery remains disabled.

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
| 613299 | `3ce83ed14a2467213b500dd3bb6b35c0107fe9fb287d862b224ff9ff1190e270` |
| 614417 | `663d782aa0b87f13accf2309af7d332b21d9ce008dcdf7430c3512460139d625` |
| 618471 | `d1be78acfff42424d443102901f59fe7fbbeef7417a296d75077c53568287a12` |
| 623981 | `f5fd076596a665b22b69980848d571252d54d4436d1aa24f43ca688153e217a3` |
| 64808 | `6021e2ac035ba6e67067aebd0b3bbc4b725c08a2f17918530fbe54e21d3455e9` |
| 164098 | `703048bc9bdba395194ea956ef01a18682c8b503ecbc7bec196fc762cc7d379f` |
| 176537 | `8485a1acd61b8883c94666da4e7c92a0ec1e5118d3e609f3680a185b1f96e4c6` |

Proof entry dictionaries bind every current list field, exact detail metadata,
archived identity, canonical identity and body digest. Future source drift fails
closed. The metadata migration fetches and verifies both current lists and both
originals before any writable connection is opened.

## Explicit metadata migration

`pipeline/apply_metadata_corrections.py --data-dir DIR` is review-only;
`--apply` atomically applies only the five reviewed metadata corrections. It starts from a healthy export,
not the corrupt failed-run snapshot. Existing raw rows, inserted_at values,
quarantine rows, and all unaffected reference records remain intact. New serving
receipts expose the verified corrected date/court. The old reference payload, the complete healthy pre-migration serving snapshot,
review JSON, before/after hashes, corrections dictionary digest and full raw
inventory digest remain in `reference_metadata_migrations` for audit/rollback.
Existing historical serving overlays are admitted to that full reference only
when the original seven raw fields/hash and existing source-bound recovery receipt
are valid and the reference exactly equals the recovered record. Missing or altered
proof blocks export; no historical recovery is reapplied.
The new reference also protects every already-verified serving record and court-code
assignment added since the original reference was established. Only the five
reviewed metadata values change. Existing title receipts retain their exact raw/title bindings and are rebound to
the new reference hash inside the same transaction. Full export must pass before
commit; any failure rolls back reference and receipt writes. Repeat application
revalidates source proofs and performs no recovery writes.

The manual `correct_reviewed_metadata` workflow input defaults to false, is
restricted to the API-only crawl job, and does not introduce R2 credentials there.
The ordinary full crawl and existing trusted/public publishing gates still run.
The explicit metadata-repair run additionally includes all eleven reviewed months
through `--verify-reviewed-ranges`; it never replaces scheduled or backlogged work.
Failure of any added month still blocks public publication.
Use `recover_reviewed_historical=false`; the 21 October recoveries are complete.

Known errors are data, not blanket exception handlers: `known-errors.json` holds
reviewed original-source errors; `reviewed-replays.json` holds exact list/detail
replay exceptions; `source-corrections.json` holds source-bound serving overlays.
`KNOWN_METADATA_ERRORS` additionally fixes each of the five serials, its permitted
changed field and safe reason code. Unknown serials, additional changed fields,
missing dictionary entries, changed input and changed original bodies raise
explicit exceptions and continue to block publication. Calendar formatting alone
is not treated as a second metadata change. No catch-and-continue bypass is added.

## Production migration audit

Run 40056234131 uses main commit
`e6a27371a55ab6f376db1a4827b51a80c2eca60d`, whose tree matches the fully tested
PR 4 head. Both PR CI 40055754703 and main CI 40056232246 passed (232 Python,
254 Jest and 29 real Store ZIP E2E tests, plus WARP smoke).
The explicit migration reported `sourceProofsVerified=true`, `applied=true`,
five reviewed changes, and 161,133 protected keys. Its preserved raw digest is
`49680b90fc5ef943149209f156456d17fbbd4997863a0cbc265799d24f40edad`.

| Audit value | SHA-256 |
| --- | --- |
| Previous reference | `40bc539ccd6796ee0639e67ade19290a81720a7e2f7f54ad878149a7cad01b17` |
| Complete healthy pre-migration serving snapshot | `d87106abee0002c8af222922ee61b3d7e27224bf03f2dcd0212e464040265d2d` |
| New reference after exactly five changes | `4c928ab7b5e0ec326727ee6bcf3762de67547beadc7f493e79478a6322b0c83c` |
| Metadata correction dictionary | `88c3003900ff17e62c8906ba666db3acab761b0331a4c466034d795a12fe218e` |

Migration success alone is not publication/recovery success. The normal complete
crawl, trusted/public publication and readback must all succeed independently.

## Production verification

The complete normal [run 40056234131](https://github.com/nash-dir/bupgogae/actions/runs/40056234131)
succeeded. It processed all 689 scheduled/reviewed/backlogged date ranges and
36 Constitutional Court pages (3,500 decisions). Failed date/page backlog was
cleared; the full completed-baseline/export gates passed. The private DB has
212,621 raw rows (+125). The new immutable public payload has 161,225 keys and
163,049 records, version 20261024. Historical recovery was disabled.

Trusted generation `20261024T033301630491Z-2474750e442c4d088fa8735354161f01`
was uploaded before the validated immutable public object and manifests/mirrors.
Its exact master SHA-256 is
`21152a52e3875e37ea2ede9ea85590b43c9ed9d5456eaaa17c6ac375b463521f`.
The public raw payload SHA-256 is
`dd71674a09041a7f74befbb51b2bab89a71ea80e4e9023efef693539491b9f36`.

Read-only [R2 readback 40058835074](https://github.com/nash-dir/bupgogae/actions/runs/40058835074)
downloaded that exact master hash, passed SQLite integrity and the entire export,
and reported `reviewedCasesAndCourtsMatch=true` against the hash-verified latest
manifest/immutable payload. It did not collect, upload or publish anything.
This verifies the current generation, not expiry of older CDN fixed-key caches.

Independent [artifact diagnostic 40058837589](https://github.com/nash-dir/bupgogae/actions/runs/40058837589)
reported `exportError=null`, `differenceCount=0`, `changedCourtCodes={}` and the
expected new reference hash. All five archived raw metadata rows still contain
their original values. Its authenticated resume-artifact master hash is
`0d30f3c589a867ed3d7cade66dd175a63cbae4fe06619fca6cc519c2c13ba66b`;
the uploaded SQLite backup has the separate exact hash above. Both exports agree.

The local immutable-public comparison checks every record of the previous healthy
161,133-key publication. Only the five explicitly approved metadata replacements
are allowed; unapproved old-record differences are zero. All old court-code
assignments, every member/value of the nine reviewed replay identities, and the
three 21 October recoveries are intact. Physical quarantine remains 49,662;
49,660 rows remain skipped during export. No unverified quarantine release,
historical recovery replay, deletion or integrity bypass was used.

The modern and legacy manifests agree on the new immutable hash; the contract
mirror also agrees. The unchanged old-client `adapters.json` is HTTP 200 with SHA
`134999d07dee2014536522000f4ba949faf03ee3f530e29fa77a7963b8624812`.
At 03:48 UTC both ordinary fixed mirrors (`db.json.gz` and `db-v0.9.0.json.gz`)
matched the new payload SHA. The complete public verification script exited zero,
including all prior-record, court-map, reviewed-identity, historical-recovery and
adapters preservation checks. Final ignored local evidence is at
`backfill/2026-10-24-integrity/after/report.json`.

At 03:35 UTC that bare URL served the prior healthy payload from Cloudflare
(`HIT`, age 2,798, `public, max-age=3600`). The ordinary GET check was kept failing
until cache expiry and the new body was actually observed. It did not change the
expected hash, bypass the ordinary URL or treat cached old content as current.

See [known-errors.md](known-errors.md) for the dictionary/exception review process.

## Local verification boundary

An older local copy, not the latest production state, was used to replay all
three captured failed months (509, 355 and 425 source rows). With the two reviewed
metadata changes applied, all three ranges passed, full export passed, no
post-migration reference differences remained, and the physical quarantine count
remained 49,662. The migration itself left the full raw inventory digest unchanged;
a repeat migration wrote nothing. These results do not establish production
recovery or the completeness of a normal daily run.

After the five-entry approval, all eleven reviewed months were also replayed
against that older local copy: 4,250 API rows, 161,195 exported keys,
`exportError=null`, `referenceDifferenceCount=0`, 49,662 physical quarantine rows.
The migration left the complete raw digest unchanged and repeat application wrote
nothing. Live read-only preflight independently verified the current official
lists, exact detail metadata and complete body hashes for all five corrections.
These are local validation results, not production publication evidence.

The read-only state diagnostic also supports the authenticated input artifact,
allowing the healthy pre-crawl state and failed post-crawl state to be distinguished
without adding R2/API credentials or rewriting either database.

Private execution evidence and source captures are ignored under
`backfill/2026-10-24-integrity/`. Extension changes from the preceding adapter task
are outside this repair and must not be included in its commit. R2 adapters.json
for older extension clients remains untouched.


Private readback retains the expected master SHA-256 requirement, SQLite integrity
check, full export/provenance validation and exact cases/court-map comparison.
The command-line verifier now obtains its comparison reference from the validated
current v0.9.0 manifest and its SHA-bound immutable object, rather than an outdated
packaged DB. Both public requests have fixed-host/path rules, redirect rejection
and bounded responses. The successful trusted upload logs its validated master
SHA-256 so a subsequent `verify_state_only` run can check the exact uploaded state
without crawling or publishing anything.
