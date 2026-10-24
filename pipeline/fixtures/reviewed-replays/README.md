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
