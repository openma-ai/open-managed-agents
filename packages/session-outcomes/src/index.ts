// Session outcome evaluation: the AMA `user.define_outcome` grader loop.
//
// Domain package (#545 §0.7). The loop, the verdict mapping and the default
// verifier/judge evaluator live here once; Cloudflare SessionDO and the Node
// managed runner only inject Ports (event sink, progress store, revision
// turn, history, judge model, rubric files, sandbox exec).
//
// Loop, per iteration (0-indexed, AMA):
//   start span → ongoing span → evaluator → end span
//   satisfied                                    → terminal
//   needs_revision on the last allowed iteration → max_iterations_reached
//   needs_revision otherwise                     → feedback user turn, re-run
//   evaluator "failed"                           → terminal failed
//   evaluator throws: aborted → interrupted, otherwise failed ("verifier error")
// A failed preparation (rubric/verifier) yields one failed verdict without a
// start span. A revision turn that throws yields a failed verdict and the
// error propagates (ADR-less §0.0 rule 16: a failed step fails the execution),
// except when the run was aborted, which propagates without a verdict.

export {
  createSessionOutcomes,
  clampOutcomeMaxIterations,
  outcomeFeedbackText,
  type SessionOutcome,
  type SessionOutcomeRubric,
  type SessionOutcomeResult,
  type SessionOutcomeUsage,
  type SessionOutcomeVerdict,
  type SessionOutcomeStarted,
  type SessionOutcomeIterationEvaluation,
  type SessionOutcomeIterationEvaluator,
  type SessionOutcomeEvaluatorPort,
  type SessionOutcomePreparation,
  type SessionOutcomeEventsPort,
  type SessionOutcomeProgressPort,
  type SessionOutcomeProgress,
  type SessionOutcomeRevisionPort,
  type SessionOutcomeDependencies,
  type SessionOutcomeReport,
  type SessionOutcomesApplication,
} from "./outcomes.js";

export {
  createVerifierOutcomeEvaluator,
  resolveOutcomeRubric,
  buildOutcomeTrajectory,
  type OutcomeRubricResolution,
  type SessionOutcomeRubricSourcePort,
  type SessionOutcomeRubricFile,
  type VerifierOutcomeEvaluatorDependencies,
} from "./verifier-evaluator.js";
