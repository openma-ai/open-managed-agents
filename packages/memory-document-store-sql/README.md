# Managed Memory metadata and object contents

`SqlMemoryDocumentStore` keeps identity, paths, revisions, actors, timestamps,
content hashes/sizes and object references in SQL. File contents, including
Memory Version snapshots, require a `MemoryContentObjects` adapter. Node supplies
its configured Memory blob store; Cloudflare supplies `MEMORY_BUCKET`.

Writes upload to a unique object key before the SQL metadata transaction. Current
and version records share an immutable object when their contents match. A losing
CAS or failed transaction can leave an unreferenced upload; it cannot overwrite
the winning revision's bytes. Garbage collection of unreferenced uploads requires
separate, reference-aware maintenance and is not performed during mutations.
Reads require the object and validate its size and SHA256. Missing configuration,
failed uploads, missing objects and corrupt objects raise errors; SQL contents are
never used as a read fallback.

Node requires either complete `MEMORY_S3_*` settings or an explicitly configured
`MEMORY_BLOB_DIR`. Any nonempty partial S3 configuration is rejected, including
when `MEMORY_BLOB_DIR` is also present. An explicitly selected filesystem is a
file backend, not an automatic fallback from S3.

Only object-backed stored documents are valid; inline content fields are rejected.
Back up SQL metadata and its referenced objects together. Objects cannot be
recovered from metadata alone.
