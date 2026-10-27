import { execFileSync } from 'node:child_process';
import { test } from 'vitest';
import assert from 'node:assert/strict';
const script = new URL('../gitleaks-range.py', import.meta.url).pathname;
const a = 'a'.repeat(40), b = 'b'.repeat(40);
function range(event, commits = []) {
  return execFileSync('python3', ['-B', '-c', `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('scan',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
print(m.commit_range(json.loads(sys.argv[2]),lambda _:json.loads(sys.argv[3])))`, script, JSON.stringify(event), JSON.stringify(commits)], {encoding:'utf8'}).trim();
}
test('push keeps the wrapper first-through-last range, or one exact commit', () => {
  assert.equal(range({commits:[{id:a},{id:b}]}), `--no-merges --first-parent ${a}^..${b}`);
  assert.equal(range({commits:[{id:a}]}), '-1');
});
test('PR uses the first and last PR commits, requires the event head, and refuses shell/options input', () => {
  const event={pull_request:{head:{sha:b}},repository:{full_name:'project-ax/ax-next'},number:123};
  assert.equal(range(event,[{sha:a},{sha:b}]), `--no-merges --first-parent ${a}^..${b}`);
  assert.throws(() => range(event,[{sha:a}]));
  assert.throws(() => range({commits:[{id:'--all'}]}));
});
