# Historical hold review — 2026-10-21

The owner requested completion of the remaining source reviews while retaining
integrity and existing client compatibility. This review covers 349026, 242327,
and the already verified but not yet collected 617561. The owner explicitly
excluded 623129 / 95재보군형공15; no client or case-code expansion is made for it.

| ID | Verified result | Root cause |
| --- | --- | --- |
| 349026 | 수원지방법원 2022구합1013, 2023-11-16 | Archived court prefix was wrong; metadata confused hearing closure 2023-09-21 with judgment date. |
| 242327 | 수원지방법원 2022구합72770, 2023-12-07 | Archived case year was 2023; both current full identifier and original header explicitly use 2022. |
| 617561 | 2023가단122878, 2024-02-06; unknown court code 0 | Outside the prior daily scan. No trial court is inferred from tax-office attribution. |

The first two originals and source metadata are pinned in the backend dictionary
`pipeline/historical-recovery.json`. Existing raw rows, inserted_at, clean number,
all quarantine entries and their aggregate digest are preserved. Separate serving
receipts bind the complete original judgment hash, exact current list/original
metadata, and exact archived raw hash. All proofs are fetched before any recovery
write; the three updates form one atomic upsert. Repeat application performs no
recovery writes. Export validates both provenance records and the existing full
reference snapshot; missing or altered provenance blocks publication.

`pipeline/apply_historical_recovery.py --data-dir DIR` is read-only review;
`--apply` explicitly applies the verified subset. The daily workflow exposes the
manual boolean `recover_reviewed_historical`, false by default. It runs only in
the API-only WARP crawl runner and uses the normal encrypted handoff, full crawl,
baseline health and separate trusted publication gates. It adds no R2 credential
to the crawler and does not alter automatic scheduling.

Local proof on an earlier Cloudflare-derived copy: +3 keys, all old raw rows and
serving records preserved, physical quarantine inventory 49,662 unchanged;
repeat result 0 insert / 0 update / 3 skip. This older local copy is not presented
as the latest production master. Current production state must be downloaded and
validated by the existing Actions prepare job before the operational application.

Detailed raw proof, current source responses, candidate copies, test logs and
resumption records are ignored under `backfill/2026-10-21-historical-holds/`.
Final Store ZIP and all frontend sources remain unchanged.
