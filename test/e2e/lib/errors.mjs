// test/e2e/lib/errors.mjs — control-flow errors shared by the runner and the cases.

/** Thrown to mark a case SKIP (not logged in, cost cap, missing tool, precondition not met). */
export class SkipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipError';
  }
}

/** Thrown by ctx.fail() to abort a case with a FAIL. */
export class CaseFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'CaseFailure';
  }
}
