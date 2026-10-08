// test/e2e/lib/check.mjs — a tiny assertion collector. A case calls ctx.check()/ctx.eq()/ctx.match() as often
// as it likes; every failure is recorded (not thrown) so one run reports everything that is wrong, and
// ctx.info() records non-asserting observations (model relay rate, timings, costs) for the summary.

import { CaseFailure, SkipError } from './errors.mjs';

function short(v, n = 240) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
}

export class Checker {
  constructor() {
    this.passes = [];
    this.failures = [];
    this.infos = [];
  }

  check(cond, label, detail) {
    if (cond) this.passes.push(label);
    else this.failures.push(detail != null ? `${label} — ${short(detail)}` : label);
    return Boolean(cond);
  }

  eq(actual, expected, label) {
    return this.check(actual === expected, label, `expected ${short(expected)}, got ${short(actual)}`);
  }

  match(text, re, label) {
    const s = String(text ?? '');
    return this.check(re.test(s), label, `${re} did not match: ${short(s)}`);
  }

  noMatch(text, re, label) {
    const s = String(text ?? '');
    return this.check(!re.test(s), label, `${re} unexpectedly matched: ${short(s)}`);
  }

  includes(text, needle, label) {
    const s = String(text ?? '');
    return this.check(s.includes(needle), label, `${JSON.stringify(needle)} not found in: ${short(s)}`);
  }

  excludes(text, needle, label) {
    const s = String(text ?? '');
    return this.check(!s.includes(needle), label, `${JSON.stringify(needle)} unexpectedly found in: ${short(s)}`);
  }

  info(message) {
    this.infos.push(String(message));
  }

  /** Abort the case with a FAIL. */
  fail(message) {
    throw new CaseFailure(message);
  }

  /** Abort the case with a SKIP. */
  skip(message) {
    throw new SkipError(message);
  }
}
