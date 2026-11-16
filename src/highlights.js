const vscode = require('vscode');
const { cSource, identifier } = require('./callers');

const stateKey = 'kernelSource.highlightNames';
const colors = [
  ['#d9a00055', '#ffd54f55'],
  ['#008a7955', '#4dd0b455'],
  ['#006dcb55', '#64b5f655'],
  ['#9b3cb555', '#ce93d855'],
  ['#be4c1455', '#ffab7055'],
  ['#b52e6255', '#f48fb155']
];

function registerHighlights(context, activeIdentifier) {
  const pinned = new Map();
  let timer;

  function refresh() {
    for (const editor of vscode.window.visibleTextEditors) {
      const { document } = editor;
      if (document.uri.scheme !== 'file' || !cSource.test(document.fileName) ||
          !vscode.workspace.getWorkspaceFolder(document.uri)) {
        continue;
      }
      const source = pinned.size ? document.getText() : '';
      for (const { pattern, decoration } of pinned.values()) {
        const ranges = [];
        for (const match of source.matchAll(pattern)) {
          ranges.push(new vscode.Range(
            document.positionAt(match.index),
            document.positionAt(match.index + match[0].length)
          ));
        }
        editor.setDecorations(decoration, ranges);
      }
    }
  }

  function add(name, slot) {
    const [light, dark] = colors[slot];
    pinned.set(name, {
      slot,
      pattern: new RegExp(`\\b${name}\\b`, 'g'),
      decoration: vscode.window.createTextEditorDecorationType({
        borderRadius: '2px',
        light: { backgroundColor: light },
        dark: { backgroundColor: dark },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
      })
    });
  }

  function clear() {
    for (const { decoration } of pinned.values()) {
      decoration.dispose();
    }
    pinned.clear();
  }

  function save() {
    return context.workspaceState.update(stateKey,
      [...pinned].map(([name, { slot }]) => ({ name, slot })));
  }

  for (const { name, slot } of context.workspaceState.get(stateKey, [])) {
    if (identifier.test(name) && colors[slot]) {
      add(name, slot);
    }
  }
  refresh();

  context.subscriptions.push(
    vscode.commands.registerCommand('kernelSource.toggleHighlight', async () => {
      const selected = activeIdentifier();
      if (!selected) {
        return;
      }
      const { name } = selected;
      if (pinned.has(name)) {
        pinned.get(name).decoration.dispose();
        pinned.delete(name);
      } else {
        const used = new Set([...pinned.values()].map(({ slot }) => slot));
        const available = colors.findIndex((_, slot) => !used.has(slot));
        add(name, available < 0 ? pinned.size % colors.length : available);
        refresh();
      }
      await save();
    }),
    vscode.commands.registerCommand('kernelSource.clearHighlights', async () => {
      clear();
      await save();
    }),
    vscode.window.onDidChangeVisibleTextEditors(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (pinned.size && event.contentChanges.length &&
          vscode.window.visibleTextEditors.some(editor => editor.document === event.document)) {
        clearTimeout(timer);
        timer = setTimeout(refresh, 100);
      }
    }),
    new vscode.Disposable(() => {
      clearTimeout(timer);
      clear();
    })
  );
}

module.exports = { registerHighlights };
