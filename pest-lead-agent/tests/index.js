// Node 24's `node --test <directory>` loads <directory>/index.js instead of expanding the directory,
// so this entry point lets `node --test pest-lead-agent/tests/` run the unit tests.
import('./unit.test.mjs');
import('./relay.test.mjs');
