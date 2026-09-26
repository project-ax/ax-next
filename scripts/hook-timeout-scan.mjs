// Read the timeout ARGUMENT every vitest hook in a source file declares, by
// PARSING the file rather than pattern-matching it.
//
// Shared by the two timeout guards:
//   - scripts/__tests__/out-of-process-test-timeouts.test.js (package configs)
//   - scripts/__tests__/scripts-suite-timeouts.test.js       (scripts/ config)
//
// Why a parser (TASK-462). Both guards used to find hooks with a regex of the
// shape `beforeAll\s*\([\s\S]*?\n\s*\}\s*,\s*(\d[\d_]*)\s*\)\s*;` — "from a hook
// keyword, lazily, to the first line that closes `}, <x>);`". That is an attempt
// to match JavaScript brace structure with a regular expression, and it fails in
// the one direction these guards cannot afford: anything INSIDE a hook's body
// that closes the same way ends the match early. A nested
//
//     beforeAll(async () => {
//       beforeEach(async () => { ... }, 30_000);   // (written multi-line)
//     }, 120_000);
//
// read as 30_000, and a plain `setTimeout(() => { ... }, 50);` statement inside
// a hook read as 50 — each time the outer, true budget was swallowed unseen. An
// under-read lowers the package maximum, and a lower maximum makes the guard's
// `hookTimeout >= max` assertion pass a config that is too low: green on the
// violation it exists to catch. The regex also could not see a single-line hook
// or a brace-less arrow body, and it credited an `it(..., MS)` budget to a bare
// hook above it. An AST has none of those failure modes, because it knows where
// the hook's call ends.
//
// `typescript` is already a root devDependency (this adds no package), its
// parser is error-tolerant, and it reads `.js` as readily as `.ts`.
//
// Direction, stated per failure mode — the guards consume these results as
// "a declared maximum" and "a list of budgets we could not read", so the safe
// direction is always to OVER-read, or to REPORT rather than skip:
//
//   - A file that does not parse cleanly is returned with `parseErrors`, and
//     both callers report it as unreadable. Fail CLOSED. (If TypeScript ever
//     stops exposing `parseDiagnostics`, this throws rather than assuming the
//     file was clean.)
//   - A timeout argument that is neither a numeric literal nor a same-file
//     numeric constant (`2 * 60_000`, an imported name, a conditional) is
//     returned in `unreadable`. Fail CLOSED.
//   - A constant declared twice resolves to the LARGER value. Fail CLOSED (the
//     TASK-410 lesson: last-write-wins made the verdict turn on declaration
//     order, and one of the orders under-read).
//   - A name resolves ONLY if every binding of it in the file is a numeric-literal
//     initialiser and it is never written again. Anything else — ASSIGNED after
//     its declaration (`X = 30_000`, `X += 1`, `X++`, a destructuring target
//     `[X] = …` / `({ X } = …)`, a loop target `for (X of …)`), or ALSO bound
//     some other way anywhere in the file (`const X = 2 * 60_000` in an inner
//     scope, a destructured `const { X } = o`, a parameter `X`, a function or
//     class named `X`) — lands in `unreadable`. Fail CLOSED. The scan is not
//     scope-aware, so without this an inner non-numeric `X` that shadows an outer
//     numeric one would resolve the hook to the OUTER value and under-read
//     (measured: outer `const X = 5_000`, inner `const X = 2 * 60_000`, a hook
//     on the inner `X` read 5_000). The cost of being file-global is the other
//     direction only: an unrelated `X` elsewhere makes this `X` unreadable — a
//     spurious red, never a hidden one.
//   - A hook called through a PROPERTY (`globalThis.beforeAll(...)`,
//     `vitest.afterAll(...)`) is read like a bare one. At worst an over-read.
//   - NOT covered, and fail-OPEN if anyone writes them: a hook invoked through
//     an alias (`const setup = beforeAll; setup(fn, 120_000)`), through element
//     access (`globalThis['beforeAll'](...)`), or with a unicode-escaped name.
//     A hook this scanner does not recognise contributes nothing to the
//     maximum. None of these occurs in the tree; they are named here rather
//     than implied away.

import ts from 'typescript';

export const HOOK_NAMES = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);

/** Cheap pre-filter: a file with none of these words cannot contain a hook call we recognise. */
const MENTIONS_A_HOOK = /\b(?:beforeAll|afterAll|beforeEach|afterEach)\b/;

function scriptKindFor(fileName) {
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(fileName)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function hookNameOf(callee) {
  if (ts.isIdentifier(callee)) return HOOK_NAMES.has(callee.text) ? callee.text : undefined;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    return HOOK_NAMES.has(callee.name.text) ? callee.name.text : undefined;
  }
  return undefined;
}

/** Every identifier a binding name introduces: `X`, `{ X, y: [Z] }`, `[X, ...R]`. */
function addBindingNames(name, into) {
  if (ts.isIdentifier(name)) into.add(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) if (ts.isBindingElement(el)) addBindingNames(el.name, into);
  }
}

/** Every identifier anywhere inside an assignment target. Over-collects on purpose: extra names only err closed. */
function addTargetNames(target, into) {
  if (ts.isIdentifier(target)) into.add(target.text);
  ts.forEachChild(target, (child) => addTargetNames(child, into));
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Every hook timeout declared in `text`.
 *
 * Returns
 *   declared:    [{ hook, ms, line, name? }] — `name` set when resolved from a const
 *   unreadable:  [{ hook, expr, line }]      — an argument this cannot evaluate
 *   parseErrors: [{ line, message }]         — non-empty means: do not trust the rest
 *
 * A hook with no second argument is BARE and appears in neither list: its budget
 * is the config's `hookTimeout`, which is what the guards are checking.
 */
export function scanHookTimeouts(text, fileName) {
  const result = { declared: [], unreadable: [], parseErrors: [] };
  if (!MENTIONS_A_HOOK.test(text)) return result;

  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  if (!Array.isArray(sf.parseDiagnostics)) {
    throw new Error(
      'hook-timeout-scan: this TypeScript no longer exposes SourceFile.parseDiagnostics, so a file that ' +
        'fails to parse would be indistinguishable from a clean one. Refusing to guess.',
    );
  }
  for (const d of sf.parseDiagnostics) {
    result.parseErrors.push({
      line: d.start === undefined ? 0 : sf.getLineAndCharacterOfPosition(d.start).line + 1,
      message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
    });
  }

  // name -> largest numeric literal it is ever initialised to, anywhere in the file.
  const consts = new Map();
  // Names that must never resolve: written after declaration, or bound anywhere
  // other than by a numeric-literal initialiser (see the header).
  const unresolvable = new Set();
  const hookCalls = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer !== undefined && ts.isNumericLiteral(node.initializer)) {
        const ms = Number(node.initializer.text);
        const seen = consts.get(node.name.text);
        consts.set(node.name.text, seen === undefined ? ms : Math.max(seen, ms));
      } else {
        addBindingNames(node.name, unresolvable);
      }
    }
    if (ts.isParameter(node)) addBindingNames(node.name, unresolvable);
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) ||
        ts.isClassExpression(node)) &&
      node.name !== undefined
    ) {
      unresolvable.add(node.name.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      addTargetNames(node.left, unresolvable);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      addTargetNames(node.operand, unresolvable);
    }
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      addTargetNames(node.initializer, unresolvable);
    }
    if (ts.isCallExpression(node)) {
      const hook = hookNameOf(node.expression);
      if (hook !== undefined && node.arguments.length >= 2) hookCalls.push({ hook, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const { hook, node } of hookCalls) {
    let arg = node.arguments[1];
    while (ts.isParenthesizedExpression(arg)) arg = arg.expression;
    const line = lineOf(sf, node);
    if (ts.isNumericLiteral(arg)) {
      result.declared.push({ hook, ms: Number(arg.text), line });
    } else if (ts.isIdentifier(arg) && consts.has(arg.text) && !unresolvable.has(arg.text)) {
      result.declared.push({ hook, ms: consts.get(arg.text), line, name: arg.text });
    } else {
      result.unreadable.push({ hook, expr: arg.getText(sf), line });
    }
  }
  return result;
}
