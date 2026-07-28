// Typed errors emitted by DreamService. The route layer maps these onto
// the Anthropic error envelope; nothing else should reach 5xx.

export class DreamNotFoundError extends Error {
  readonly code = "dream_not_found";
  constructor(message = "Dream not found") {
    super(message);
  }
}

/** Caller tried to cancel a dream that's already in a terminal state, OR
 *  archive a dream that's still running/pending. The spec maps both to 400. */
export class DreamInvalidStateError extends Error {
  readonly code = "dream_invalid_state";
  constructor(message: string) {
    super(message);
  }
}

/** Input validation — missing required field, bad model, too many sessions, etc. */
export class DreamInvalidInputError extends Error {
  readonly code = "dream_invalid_input";
  constructor(message: string) {
    super(message);
  }
}

/** The supplied input memory store doesn't exist for this tenant. Maps to 400
 *  (the spec returns the validation error at create time; the run-time
 *  `input_memory_store_unavailable` error type is reserved for stores that
 *  vanish mid-run — see the pipeline driver). */
export class DreamInputMemoryStoreMissingError extends Error {
  readonly code = "dream_input_memory_store_missing";
  constructor(public storeId: string) {
    super(`input memory_store_id not found: ${storeId}`);
  }
}

/** One of the supplied input sessions doesn't exist for this tenant. */
export class DreamInputSessionMissingError extends Error {
  readonly code = "dream_input_session_missing";
  constructor(public sessionId: string) {
    super(`input session_id not found: ${sessionId}`);
  }
}
