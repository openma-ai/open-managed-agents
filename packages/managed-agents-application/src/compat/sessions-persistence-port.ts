/** @deprecated v0 compatibility; v1 consumers use @open-managed-agents/session-store. */
export type {
  ArchiveSessionRecord,
  ArchiveSessionRecordResult,
  DeleteSessionRecordResult,
  FindCurrentSessionRecord,
  InsertSessionRecord,
  ListSessionRecords,
  ReplaceSessionRecord,
  ReplaceSessionRecordResult,
  SessionListPosition,
  SessionResourceSecret,
  StoredSession,
} from "@openma/core/storage/sessions";

/** @deprecated v0 compatibility; v1 consumers use SessionStore. */
export type {
  SessionStore as SessionPersistencePort,
} from "@openma/core/storage/sessions";
