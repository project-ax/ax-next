#!/usr/bin/env node
// Exits immediately with code 0. Used by the "kill after already-exited"
// test to verify kill() is a no-op when the child is already gone.
process.stdout.write('bye\n');
process.exit(0);
