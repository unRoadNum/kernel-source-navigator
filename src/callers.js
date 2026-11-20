const { spawn } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { rgPath } = require('@vscode/ripgrep');
const { Language, Parser, Query } = require('web-tree-sitter');

const cSource = /\.[ch]$/i;
const identifier = /^[A-Za-z_]\w*$/;
const cGrammar = path.join(__dirname, '..', 'node_modules', 'tree-sitter-c', 'tree-sitter-c.wasm');
const kernelQualifiers = [
  '__init', '__exit', '__meminit', '__memexit', '__ref', '__cpuinit', '__cpuexit',
  '__cold', '__hot', '__always_inline', '__maybe_unused', '__always_unused',
  '__iomem', '__user', '__percpu', '__rcu', '__force', '__bitwise',
  '__weak', '__visible', '__must_check', '__noreturn', '__sched', '__noclone',
  'asmlinkage', 'noinline', 'notrace'
];
const qualifierSet = new Set(kernelQualifiers);
const sourceTokens = new RegExp([
  String.raw`^[\t ]*#[^\r\n]*(?:(?<=\\)\r?\n[^\r\n]*)*`,
  String.raw`/\*[\s\S]*?\*/|//[^\r\n]*`,
  String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'`,
  `\\b(?:${kernelQualifiers.join('|')})\\b`
].join('|'), 'gm');
let language;

function parseSource(parser, source) {
  // Mask bare kernel annotations while preserving every editor offset.
  return parser.parse(source.replace(sourceTokens, token =>
    qualifierSet.has(token) ? ' '.repeat(token.length) : token));
}

function loadLanguage() {
  if (!language) {
    language = Parser.init()
      .then(() => Language.load(cGrammar))
      .catch(error => {
        language = undefined;
        throw error;
      });
  }
  return language;
}

function pathKey(file) {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inFolder(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function candidateFiles(root, name, signal) {
  return new Promise((resolve, reject) => {
    const scan = spawn(rgPath, [
      '--no-config', '--files-with-matches', '--null', '--fixed-strings', '--word-regexp',
      '--iglob', '*.[ch]', '--', name, '.'
    ], { cwd: root, windowsHide: true, signal });
    const files = [];
    let pending = '';
    let stderr = '';
    scan.stdout.setEncoding('utf8').on('data', chunk => {
      const paths = (pending + chunk).split('\0');
      pending = paths.pop();
      for (const file of paths) {
        files.push(path.resolve(root, file));
      }
    });
    scan.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    scan.once('error', reject);
    scan.once('close', code => {
      if (code === 0 || code === 1) {
        resolve({ files, warning: '' });
      } else if (files.length > 0) {
        resolve({ files, warning: stderr.trim() || `ripgrep 退出码 ${code}` });
      } else {
        reject(new Error(stderr.trim() || `ripgrep 退出码 ${code}`));
      }
    });
  });
}

function definitionName(definition) {
  let declarator = definition.childForFieldName('declarator');
  let isFunction = false;
  while (declarator && declarator.type !== 'identifier') {
    isFunction ||= declarator.type === 'function_declarator';
    if (declarator.type === 'parenthesized_declarator') {
      declarator = declarator.firstNamedChild;
    } else {
      declarator = declarator.childForFieldName('declarator');
    }
  }
  return isFunction ? declarator : undefined;
}

function enclosingFunction(node) {
  while (node && node.type !== 'function_definition') {
    node = node.parent;
  }
  return node;
}

function isStaticDefinition(parser, origin, name) {
  if (!origin || !/\.c$/i.test(origin.file)) {
    return false;
  }
  const tree = parseSource(parser, origin.text);
  try {
    const node = tree.rootNode.descendantForIndex(origin.offset, origin.offset + name.length);
    const definition = enclosingFunction(node);
    if (!definition || definitionName(definition)?.startIndex !== origin.offset) {
      return false;
    }
    return definition.namedChildren.some(child =>
      child.type === 'storage_class_specifier' && child.text === 'static');
  } finally {
    tree.delete();
  }
}

function declaratorName(node) {
  while (node && node.type !== 'identifier') {
    node = node.type === 'parenthesized_declarator'
      ? node.firstNamedChild : node.childForFieldName('declarator');
  }
  return node;
}

function globalDeclarations(root) {
  return root.descendantsOfType('declaration').filter(node => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (['function_definition', 'compound_statement', 'struct_specifier', 'union_specifier'].includes(parent.type)) {
        return false;
      }
    }
    return !node.namedChildren.some(child => child.type === 'storage_class_specifier' && child.text === 'typedef');
  });
}

function assignmentTarget(node) {
  if (node?.type === 'identifier') return { root: node.text, label: node.text };
  if (node?.type === 'field_expression' && node.childForFieldName('operator')?.text === '.') {
    const base = assignmentTarget(node.childForFieldName('argument'));
    return base && { root: base.root, label: `${base.label}.${node.childForFieldName('field').text}` };
  }
  return undefined;
}

function isShadowed(node, name) {
  const fn = enclosingFunction(node);
  if (!fn) return false;
  const parameters = fn.childForFieldName('declarator').descendantsOfType('parameter_declaration');
  if (parameters.some(param => declaratorName(param.childForFieldName('declarator'))?.text === name)) return true;
  for (let scope = node.parent; scope && scope.id !== fn.id; scope = scope.parent) {
    if (!['compound_statement', 'for_statement'].includes(scope.type)) continue;
    for (const declaration of scope.descendantsOfType('declaration')) {
      let owner = declaration.parent;
      while (owner && !['compound_statement', 'for_statement'].includes(owner.type)) owner = owner.parent;
      if (owner?.id !== scope.id) continue;
      if (declaration.childrenForFieldName('declarator').some(d => declaratorName(d)?.text === name)) return true;
    }
  }
  return false;
}

function collectRegistrations(tree, query, file) {
  const globals = new Set();
  const declarations = globalDeclarations(tree.rootNode);
  for (const declaration of declarations) {
    for (const d of declaration.childrenForFieldName('declarator')) {
      const name = declaratorName(d);
      if (name) globals.add(name.text);
    }
  }
  const registrations = [];
  for (const { node } of query.captures(tree.rootNode)) {
    let value = node;
    while (value.parent?.type === 'parenthesized_expression' ||
      (value.parent?.type === 'pointer_expression' && value.parent.childForFieldName('operator')?.text === '&')) {
      value = value.parent;
    }
    const parent = value.parent;
    let label;
    if (parent?.type === 'assignment_expression' && parent.childForFieldName('right')?.id === value.id &&
      parent.childForFieldName('operator')?.text === '=') {
      const target = assignmentTarget(parent.childForFieldName('left'));
      if (target && globals.has(target.root) && !isShadowed(parent, target.root)) label = target.label;
    } else {
      let current = value;
      let suffix = '';
      while (current.parent?.type === 'initializer_pair' && current.parent.childForFieldName('value')?.id === current.id) {
        const pair = current.parent;
        suffix = pair.childrenForFieldName('designator').map(d => d.text).join('') + suffix;
        current = pair.parent;
      }
      const init = current.parent;
      if (init?.type === 'init_declarator' && init.childForFieldName('value')?.id === current.id &&
        declarations.some(d => d.id === init.parent?.id)) {
        const name = declaratorName(init.childForFieldName('declarator'));
        if (name) label = name.text + suffix;
      }
    }
    if (label) registrations.push({ kind: 'registration', file, name: label, position: node.startPosition, calls: [] });
  }
  return registrations;
}

function collectCalls(parser, query, registrationQuery, text, file) {
  const tree = parseSource(parser, text);
  try {
    const callers = new Map();
    for (const { node: callee } of query.captures(tree.rootNode)) {
      const definition = enclosingFunction(callee);
      const body = definition?.childForFieldName('body');
      if (!body || callee.startIndex < body.startIndex || callee.endIndex > body.endIndex) {
        continue;
      }
      const caller = definitionName(definition);
      if (!caller) {
        continue;
      }
      let result = callers.get(caller.startIndex);
      if (!result) {
        result = { file, name: caller.text, position: caller.startPosition, calls: [] };
        callers.set(caller.startIndex, result);
      }
      result.calls.push(callee.startPosition);
    }
    return [...callers.values(), ...collectRegistrations(tree, registrationQuery, file)];
  } finally {
    tree.delete();
  }
}

async function findCallers({ root, name, origin, documents = [], signal }) {
  if (!identifier.test(name)) {
    throw new Error('需要完整的 C 标识符');
  }
  const c = await loadLanguage();
  signal?.throwIfAborted();
  const parser = new Parser().setLanguage(c);
  const query = new Query(c, `
    ((call_expression function: (identifier) @callee)
      (#eq? @callee "${name}"))
  `);
  const registrationQuery = new Query(c, `((identifier) @hook (#eq? @hook "${name}"))`);
  try {
    let originText = origin?.text;
    if (origin && originText === undefined) {
      try {
        originText = await readFile(origin.file, { encoding: 'utf8', signal });
      } catch (error) {
        signal?.throwIfAborted();
      }
    }
    const localOnly = isStaticDefinition(parser,
      origin && originText !== undefined ? { ...origin, text: originText } : undefined, name);
    const { files, warning } = localOnly
      ? { files: [origin.file], warning: '' }
      : await candidateFiles(root, name, signal);
    const candidates = new Map(files.map(file => [pathKey(file), { file }]));
    if (!localOnly) {
      for (const document of documents) {
        if (cSource.test(document.file) && inFolder(root, document.file)) {
          candidates.set(pathKey(document.file), document);
        }
      }
    }
    if (origin) {
      candidates.set(pathKey(origin.file), origin);
    }

    const results = [];
    const unreadable = [];
    const spelling = new RegExp(`\\b${name}\\b`);
    for (const { file, text } of candidates.values()) {
      signal?.throwIfAborted();
      let source = text;
      if (source === undefined) {
        try {
          source = await readFile(file, { encoding: 'utf8', signal });
        } catch (error) {
          signal?.throwIfAborted();
          unreadable.push(file);
          continue;
        }
      }
      if (spelling.test(source)) {
        results.push(...collectCalls(parser, query, registrationQuery, source.replace(/^\uFEFF/, ''), file));
      }
    }
    signal?.throwIfAborted();
    results.sort((a, b) => a.file.localeCompare(b.file) || a.position.row - b.position.row);
    return { results, warning, unreadable, localOnly };
  } finally {
    query.delete();
    registrationQuery.delete();
    parser.delete();
  }
}

module.exports = { cSource, findCallers, identifier };
