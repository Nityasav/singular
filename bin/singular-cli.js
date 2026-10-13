#!/usr/bin/env node
// bin/singular-cli.js — the `singular` binary of the singular-skill npm package.
//
//   npm install -g singular-skill   (or: npx singular-skill install)
//   singular install                 copies the plugin payload to ~/.claude/singular/plugin and registers it with
//                                    Claude Code (claude plugin marketplace add + claude plugin install singular@singular)
//   singular update | uninstall [--purge] | status | doctor
//   singular find|add|mode|init|load ...  the /singular subcommands from a terminal
//
// Everything lives in lib/cli-core.js (injectable deps; see test/unit-cli.test.js). This file only maps argv to an
// exit code. Zero dependencies; every subprocess is an execFile with an argument array, never a shell string.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../lib/cli-core.js';

export { runCli };

export async function main(argv = process.argv.slice(2)) {
  return runCli(argv);
}

// npm links <prefix>/bin/singular -> ../lib/node_modules/singular-skill/bin/singular-cli.js: process.argv[1] is the
// symlink while import.meta.url is the real file, so both sides are compared after realpath (the other bin/ scripts
// are only ever run by their real path).
const isEntrypoint = (() => {
  try {
    if (!process.argv[1]) return false;
    const real = (p) => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return path.resolve(p);
      }
    };
    return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`singular: ${String(err?.message ?? err)}\n`);
      process.exit(1);
    },
  );
}
