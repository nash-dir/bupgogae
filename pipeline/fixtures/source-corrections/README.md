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
