# Official-detail replay fixtures

Captured on 2026-10-21 using the official law.go.kr precedent detail API.
Each gzip JSON contains only the four public metadata fields and the complete
judgment body used by `reviewed-replays.json`. No OC/API key, response URL or
administrative fields are included. Two list entries omit merged members; two
use different branch court labels. Existing reviewed identities remain intact.
A fixture or metadata change invalidates the corresponding pinned body hash.


The 2026-10-24 review adds 192184, 623971, 624491, 614353 and 616625.
Their list summaries omit merged members or counterclaims while the exact official
metadata and full bodies retain them. The pinned canonical records preserve every
existing member, date and court. The resolver also verifies these proofs on fresh
collection; no existing DB row is required to reconstruct the reviewed identity.

The full normal crawl then exposed four more existing reviewed identities:
613299 (2022-05), 614417 (2023-08), and 618471/623981 (2024-11).
The first two lists spell the branch as 재판부; 618471 omits the merged
2024고단1582; 623981 omits the (울산) prefix present in official detail.
Their four public metadata fields and complete bodies are pinned in the same
format. Existing raw, reviewed serving records, dates and courts are preserved.
