/** @deprecated Use `SessionResourceStore`. */
export type {
  FindCurrentSessionResources,
  ReplaceCurrentSessionResources,
  ReplaceCurrentSessionResourcesResult,
  SessionResourceSecretChange,
  SessionResourceStore as SessionResourcePersistencePort,
  StoredSessionResources,
} from "../../storage/session-resources.js";
