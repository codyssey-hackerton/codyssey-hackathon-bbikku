# Temporary PostgreSQL repository contract

`pikku_user_state_v1` is a normal durable table with `user_id` as the primary key,
`schema_version=1`, a versioned `state` JSONB document and an update timestamp.
The document stores user-scoped schedule and context revisions, items, facts,
proposals, approval snapshots, conversations, idempotency records and review state.
Writers lock the user row with `SELECT ... FOR UPDATE`; the entity/version checks,
user state and idempotency results must commit together. This is an interim
implementation contract, not the team's final normalized schema. Coordinate a
forward migration with the database owner before changing it. The migration is
idempotent and does not reset, truncate or drop existing data.

The contact-response increment adds optional `contactResponses` and
`voiceSessions` entries to the JSONB document. Legacy rows decode to empty maps;
nonempty entries persist together with the associated schedule changes.
Older servers reject these new keys with their strict decoder. Upgrade all API
and scheduler processes sharing this database together; do not run old and new
writers against the same data or assume a code-only rollback is compatible.
