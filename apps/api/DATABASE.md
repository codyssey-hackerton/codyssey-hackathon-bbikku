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
