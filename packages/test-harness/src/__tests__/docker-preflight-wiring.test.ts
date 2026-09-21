import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const skip = new Set(['node_modules', 'dist', 'dist-web', 'build', 'coverage']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || skip.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

function inspect(text: string, filename = 'fixture.ts'): { count: number; unguarded: number[] } {
  const file = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const constructors = new Set<string>();
  const namespaces = new Set<string>();
  const starters = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.isTypeOnly || bindings === undefined) continue;
    if (/^(?:@testcontainers\/|testcontainers$)/.test(from)) {
      if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else for (const item of bindings.elements) {
        if (!item.isTypeOnly && (item.propertyName ?? item.name).text.endsWith('Container')) constructors.add(item.name.text);
      }
    }
    if (from === '@ax/test-harness' && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if (!item.isTypeOnly && (item.propertyName ?? item.name).text === 'startTestContainer') starters.add(item.name.text);
      }
    }
  }
  let count = 0;
  const unguarded: number[] = [];
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node)) {
      const name = node.expression;
      const isContainer = ts.isIdentifier(name) ? constructors.has(name.text)
        : ts.isPropertyAccessExpression(name) && ts.isIdentifier(name.expression)
          && namespaces.has(name.expression.text) && name.name.text.endsWith('Container');
      if (isContainer) {
        count++;
        let builder: ts.Node = node;
        while (builder.parent !== undefined && ts.isPropertyAccessExpression(builder.parent)
          && builder.parent.expression === builder && builder.parent.name.text !== 'start'
          && ts.isCallExpression(builder.parent.parent) && builder.parent.parent.expression === builder.parent) {
          builder = builder.parent.parent;
        }
        const parent = builder.parent;
        const guarded = parent !== undefined && ts.isCallExpression(parent)
          && ts.isIdentifier(parent.expression) && starters.has(parent.expression.text)
          && parent.arguments[0] === builder;
        if (!guarded) unguarded.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { count, unguarded };
}

const imported = "import { PostgreSqlContainer } from '@testcontainers/postgresql';\n";
const checked = "import { startTestContainer } from '@ax/test-harness';\n";
const construct = ['new', 'PostgreSqlContainer'].join(' ');

describe('Docker startup wiring', () => {
  it.skipIf(process.platform === 'win32')('excludes symlinked source entries from the scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-preflight-scan-'));
    try {
      const sourceDir = join(dir, 'sources');
      mkdirSync(sourceDir);
      writeFileSync(join(dir, 'outside.ts'), '');
      writeFileSync(join(sourceDir, 'real.ts'), '');
      symlinkSync(join(dir, 'outside.ts'), join(sourceDir, 'linked.ts'));
      expect(sources(sourceDir)).toEqual([join(sourceDir, 'real.ts')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks the real constructor use rather than comments or string literals', () => {
    expect(inspect(`${imported}const note = 'startTestContainer(${construct}())';\n${construct}('image').start();`)).toEqual({ count: 1, unguarded: [3] });
  });

  it('requires the harness import, not merely a same-named local function', () => {
    expect(inspect(`${imported}function startTestContainer(x) { return x.start(); }\nstartTestContainer(${construct}('image'));`).unguarded).toHaveLength(1);
  });

  it('rejects startup performed before the checked wrapper can run', () => {
    expect(inspect(`${imported}${checked}startTestContainer(${construct}('image').start());`).unguarded).toHaveLength(1);
  });

  it('accepts a checked builder including chained builder configuration', () => {
    expect(inspect(`${imported}${checked}startTestContainer(${construct}('image').withDatabase('test'));`)).toEqual({ count: 1, unguarded: [] });
  });

  it('tracks named and namespace container imports', () => {
    expect(inspect("import { PostgreSqlContainer as Pg } from '@testcontainers/postgresql';\nnew Pg('image').start();").unguarded).toHaveLength(1);
    expect(inspect("import * as tc from 'testcontainers';\nnew tc.GenericContainer('image').start();").unguarded).toHaveLength(1);
  });

  it('routes every current literal Testcontainers startup through the shared preflight wrapper', () => {
    const findings: string[] = [];
    const consumers: string[] = [];
    for (const path of ['packages', 'presets'].flatMap((root) => sources(join(repo, root)))) {
      const text = readFileSync(path, 'utf8');
      if (!/['"](?:@testcontainers\/[^'"]+|testcontainers)['"]/.test(text)) continue;
      const result = inspect(text, path);
      if (result.count > 0) consumers.push(relative(repo, path));
      for (const line of result.unguarded) findings.push(`${relative(repo, path)}:${line}`);
    }
    expect(consumers).toContain('packages/storage-postgres/src/__tests__/plugin.test.ts');
    expect(findings).toEqual([]);
  });
});
