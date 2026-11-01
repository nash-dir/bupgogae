# 613735 original-source correction

Captured on 2026-10-21 from the public NTS judgment linked by the law.go.kr
`precInfoP.do?precSeq=613735&mode=0` referral. The exact original URL and expected
list fields are pinned in `pipeline/source-corrections.json`; no OC/API key is
included in either fixture.

The list and original-source metadata say `2026.12.11`, but the original judgment
HTML explicitly labels `판 결 선 고` followed by `2025.12.11` and identifies
`2025두34754`. The dictionary corrects only the served date; the erroneous raw
metadata stays unchanged. The whole original HTML SHA-256 is
`576e32076ada8cf4c2142fa2545c06dcc3d76c3df16811c88536d57cef2680c5`.

`613735-original.json` keeps only the public document identifier, three relevant
metadata fields, and original HTML needed to replay the frontend's read-only
`ASIQTB002PR01` response. Internal staff information and unrelated response fields
are omitted. `613735-judgment.html.gz` preserves the exact embedded judgment HTML.


Nine additional reviewed NTS court decisions (2026-10-21) preserve missing court
information explicitly. Three judgment headers verify the full branch court, retained in `verifiedCourt`
evidence; all nine preserve their protected published unknown court code 0. Registration offices mentioned in orders
are not used as trial-court evidence. Exact API fields, original metadata
(including two title trailing spaces), and whole HTML hashes are pinned separately.
No generalized title trimming or court inference is performed.


`202029-original.json.gz` is the official law.go.kr detail metadata and complete
judgment body. The list omits four merged members and changes the branch label.
The dictionary preserves public parent court code 11 and all five explicitly
written members. The complete 74-character source string remains in metadata;
the serving record uses 54 canonical characters without dropping any number.

## 2026-10-24 metadata corrections

69909 and 185122 add public-only official law.go.kr detail fixtures. Their exact
list fields, metadata and full body digests are pinned in source-corrections.json.
These entries require an explicit atomic reference migration for an existing
published DB; ordinary collection cannot silently alter its reference. The owner
approved the verified date correction (2004-10-28 to 2004-10-07) and the explicit
서울고등법원 춘천재판부 correction. Original raw rows and the complete old reference
remain in the migration audit. See docs/ingestion-integrity-repair-2026-10-24.md.

The full normal crawl additionally exposed 64808 (2008-08-11 to 2008-08-21),
164098 (광주고등법원 to 제주재판부), and 176537 (부산고등법원 to 창원재판부).
The owner separately approved all three exact changes. Their public-only metadata
and complete bodies use the same fixture format and source-bound hashes.
`KNOWN_METADATA_ERRORS` fixes the five serials, the one permitted changed field
for each, and a safe reason code. Extra fields, unknown serials or missing entries
fail with explicit exceptions; this is not a general metadata replacement rule.

2026-11-01: 145396 and 182768 pin complete official detail JSON, including all four metadata fields and judgment bodies. Exact list and detail evidence preserves the existing published parent court codes 13/14 despite branch labels in the lists; it does not change historical court identity.
