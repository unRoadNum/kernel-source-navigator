const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { findCallers } = require('../src/callers');

test('separates direct callers and explicit global hook registrations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kernel-callers-'));
  try {
    const file = path.join(root, 'hooks.c');
    const text = `
static void target(void) {}
static struct ops driver = {
  .probe = target,
  .nested = { .remove = &target },
};
void (*hook)(void) = (target);
static struct ops other;
typedef void (*target_type)(void);
void setup(void) {
  other.probe = &target;
  hook = (target);
  target();
  register_callback(target);
  struct ops local = { .probe = target };
  local.probe = target;
  unknown.probe = target;
  ptr->probe = target;
}
void shadow_parameter(struct ops driver) { driver.probe = target; }
void shadow_local(void) { struct ops other; other.probe = target; }
void shadow_block(void) { { struct ops other; other.probe = target; } }
void shadow_hook(void (*hook)(void)) { hook = target; }
void expression(void) { hook = wrap(target); }
// .probe = target
const char *description = ".probe = target";
`;
    await fs.writeFile(file, text);
    const result = await findCallers({ root, name: 'target', origin: { file, text, offset: text.indexOf('target') } });
    assert.equal(result.localOnly, true);
    const hooks = result.results.filter(item => item.kind === 'registration');
    assert.deepEqual(hooks.map(item => item.name), ['driver.probe', 'driver.nested.remove', 'hook', 'other.probe', 'hook']);
    for (const hook of hooks) {
      assert.equal(text.split('\n')[hook.position.row].slice(hook.position.column, hook.position.column + 6), 'target');
    }
    const calls = result.results.filter(item => item.kind !== 'registration');
    assert.deepEqual(calls.map(item => [item.name, item.calls.length]), [['setup', 1]]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('searches other files and uses unsaved document contents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kernel-callers-'));
  try {
    const file = path.join(root, 'target.c');
    const registrationFile = path.join(root, 'ops.c');
    const text = 'void target(void) {}';
    await fs.writeFile(file, text);
    await fs.writeFile(registrationFile, 'struct ops driver = { .probe = old_target };');
    const result = await findCallers({ root, name: 'target', origin: { file, text, offset: 5 },
      documents: [{ file: registrationFile, text: 'struct ops driver = { .probe = target };' }] });
    assert.equal(result.localOnly, false);
    assert.deepEqual(result.results.map(item => [item.kind, item.name]), [['registration', 'driver.probe']]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
