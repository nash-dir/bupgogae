# Historical recovery evidence

These fixtures contain only the four public NTS document metadata fields used by
the verifier and the original, already redacted judgment HTML. API credentials,
detail links containing OC, internal NTS user identifiers and unrelated response
fields are excluded. Gzip timestamps are fixed for reproducibility.

- 349026: https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=200000000000003019
  Original header: 2022구합1013, 판결선고 2023.11.16. Current document identifier
  explicitly says 수원지방법원; old archived raw incorrectly says 서울지방법원.
  API/document metadata 2023.09.21 is the original's 변론종결 date.
- 242327: https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=200000000000009791
  Original header: 2022구합72770, 판결선고 2023.12.7. Current document identifier
  explicitly says 수원지방법원. Archived raw incorrectly uses year 2023.

Both exact referrals from law.go.kr, all four original metadata fields, all seven
current list fields, the complete judgment HTML SHA-256, and all seven archived
SQLite columns are required. The registry is `pipeline/historical-recovery.json`.
The raw rows and quarantine inventory remain unchanged; separate reviewed serving
receipts restore only the verified identities.

623129 / 95재보군형공15 is deliberately excluded by the repository owner's
2026-10-21 instruction. It is a real outlier, not a falsely labelled judgment.
Its ID is explicitly skipped by the existing backend blacklist. No codec,
frontend regex, alias expansion, or shortened case number is introduced.
