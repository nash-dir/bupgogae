# Known ingestion errors

Known errors are repository-bundled, reviewed dictionaries. An entry authorizes
only its exact source identity and evidence. A matching serial alone never
authorizes a correction, a quarantine release or publication.

## Dictionaries

| Dictionary | Purpose | Required proof |
| --- | --- | --- |
| `pipeline/known-errors.json` | Reviewed original-source errors and explicit holds | Exact list fields and the two reviewed original sources; held/duplicate dispositions remain blocked |
| `pipeline/reviewed-replays.json` | Preserve an existing verified identity when list summaries omit members or spell a branch differently | Exact list, archived/canonical records, four official detail fields and complete judgment SHA-256 |
| `pipeline/source-corrections.json` | Source-bound serving overlays without editing archived raw | Profile-specific exact metadata, original body hash, previous raw and canonical record |
| `KNOWN_METADATA_ERRORS` in `pipeline/source_corrections.py` | Restrict the explicit metadata migration | Exact five reviewed serials, permitted changed field and safe reason; detailed evidence stays in `source-corrections.json` |

The current metadata exceptions are 69909/64808 (date) and
185122/164098/176537 (court). Calendar formatting alone is not a date correction.
Changing a title, full case number, another field or an unregistered serial is
not covered by these exceptions.

## Exceptions and failure behavior

`CorrectionError` carries a safe enum, never request URLs, API credentials or
original response text. The crawler records failed ranges in durable backlog;
any failed range still blocks public publication.

| Error | Meaning | Required next step |
| --- | --- | --- |
| `known_error_review_required` | Held/unreviewed source or a mismatch with reviewed historical identity | Compare the original and existing review; do not discard the row |
| `known_error_input_changed` | Exact reviewed list fields changed | Obtain a new source review |
| `known_error_source_changed` | Detail metadata/body differs from pinned evidence | Obtain and compare the complete current original |
| `known_error_source_unavailable` | Source proof could not be fetched | Retry without accepting the unverified input |
| `known_error_unreviewed_metadata` | Unknown serial or a change outside the registered permitted field | Review the exact additional change before extending the dictionary |
| `metadata_migration_inventory_mismatch` | Metadata registry and exception dictionary disagree | Repair the reviewed configuration; do not reduce the integrity gate |
| `reference_metadata_migration_required` | Normal collection attempted a protected metadata correction | Use the explicit reviewed migration on healthy trusted input |
| `merged_case_members_removed` | New input would remove an existing member | Verify the full original and preserve every reviewed member |
| `reference_record_removed_or_changed` | Full export differs from a protected reference record | Diagnose the state and review the exact difference; publishing remains blocked |

Unknown exception text is reduced to a generic safe classification. Known safe
metadata errors retain their exact enum in crawler and trusted-upload logs.

## Reviewing another entry

1. Use the read-only state diagnostic to identify the exact protected difference.
   Authenticate the source run/repository/branch/SHA and distinguish healthy input
   from failed resume state. Artifacts currently expire after one day.
2. Compare the current official list, complete detail/original, archived raw,
   existing correction receipt and published reference. Record complete body
   hashes and public-only fixtures. A list summary is not proof of member removal.
3. Pin the complete expected input and the exact canonical record. A new public
   metadata change requires approval for its explicit before/after values and an
   update to the permitted-field dictionary; do not infer unrelated fields.
4. Test rejection of source drift and extra field changes, raw preservation,
   atomic rollback, repeat application without writes, and full export. Do not
   release physical quarantine without its separately verified recovery proof.
5. Run normal complete collection, including reviewed ranges and backlog. Require
   all publication gates, successful private state/public publication, and exact
   private/public readback before declaring recovery complete.

`pipeline/apply_metadata_corrections.py --data-dir DIR` is read-only by default.
`--apply` is the explicit atomic migration. It verifies current sources before
opening a writable connection, requires a healthy full export, preserves raw and
quarantine, archives the previous reference and complete serving snapshot, records
before/after hashes, and commits only after the resulting full export passes.
Failed resume state is diagnostic evidence, not migration input.

The manual workflow flag `correct_reviewed_metadata=true` runs that migration and
adds the reviewed months to the normal schedule. It never replaces normal work.
Keep `recover_reviewed_historical=false` for the already completed 2026-10-21
recoveries (349026, 242327 and 617561). Details and source hashes are recorded in
`docs/ingestion-integrity-repair-2026-10-24.md`.
