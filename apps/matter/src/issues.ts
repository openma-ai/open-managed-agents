/**
 * A problem with a Loop's configuration, in a form a console can translate:
 * `field` is the config key, `code` names the rule, `params` fill the
 * sentence. `message` is the English text the API also returns in `problems`.
 */
export interface LoopIssue {
  readonly field?: string;
  readonly code: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly message: string;
}

/** The issue as the API sends it: without the English message. */
export const issueJson = ({ message: _message, ...issue }: LoopIssue) => issue;

/** A Loop names an Environment, Vault or Agent that does not exist. */
export class MissingReferenceError extends Error {
  readonly issue: LoopIssue;
  constructor(field: string, kind: string, id: string) {
    const message = `${kind} ${id} not found`;
    super(message);
    this.name = "MissingReferenceError";
    this.issue = { field, code: "not_found", params: { id }, message };
  }
}
