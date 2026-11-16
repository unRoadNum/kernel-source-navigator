const vscode = require('vscode');
const { cSource, findCallers, identifier } = require('./callers');
const { registerHighlights } = require('./highlights');

function activeIdentifier() {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  const folder = document && vscode.workspace.getWorkspaceFolder(document.uri);
  if (!document || document.uri.scheme !== 'file' || !folder || !cSource.test(document.fileName)) {
    vscode.window.showInformationMessage('请在打开的工作区中选择 .c 或 .h 文件里的标识符。');
    return undefined;
  }
  const { selection } = editor;
  const range = selection.isEmpty
    ? document.getWordRangeAtPosition(selection.active, /[A-Za-z0-9_]+/)
    : selection;
  const name = range && document.getText(range);
  if (!name || !identifier.test(name) ||
      !range.isEqual(document.getWordRangeAtPosition(range.start, /[A-Za-z0-9_]+/) ?? range)) {
    vscode.window.showInformationMessage('请将光标放在 C 标识符上，或选中完整名称。');
    return undefined;
  }
  return { name, document, folder, offset: document.offsetAt(range.start) };
}

function position(point) {
  return new vscode.Position(point.row, point.column);
}

function openCommand(file, point) {
  const cursor = position(point);
  return {
    command: 'vscode.open',
    title: '打开源码位置',
    arguments: [vscode.Uri.file(file), {
      selection: new vscode.Range(cursor, cursor),
      preview: true
    }]
  };
}

class CallersProvider {
  constructor() {
    this.change = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.change.event;
    this.callers = [];
  }

  replace(callers) {
    this.callers = callers;
    this.change.fire();
  }

  getChildren(element) {
    if (!element) {
      return this.callers;
    }
    return element.calls?.map(point => ({ file: element.file, position: point })) ?? [];
  }

  getTreeItem(element) {
    const { file, name, calls, position: point } = element;
    const hasChildren = calls?.length > 1;
    const item = new vscode.TreeItem(
      name ?? `第 ${point.row + 1} 行，第 ${point.column + 1} 列`,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    const destination = calls?.length === 1 ? calls[0] : point;
    const location = `${vscode.workspace.asRelativePath(file)}:${destination.row + 1}`;
    item.description = hasChildren ? `${location} · ${calls.length} 处调用` : location;
    item.iconPath = new vscode.ThemeIcon(name ? 'symbol-function' : 'go-to-file');
    item.command = openCommand(file, destination);
    return item;
  }
}

function activate(context) {
  const provider = new CallersProvider();
  const view = vscode.window.createTreeView('kernelSource.callers', { treeDataProvider: provider });
  const output = vscode.window.createOutputChannel('Kernel Source Navigator');
  let currentSearch;

  const find = vscode.commands.registerCommand('kernelSource.findCallers', async () => {
    const selected = activeIdentifier();
    if (!selected) {
      return;
    }
    const { name, document, folder, offset } = selected;
    currentSearch?.abort();
    const search = new AbortController();
    currentSearch = search;
    const origin = { file: document.fileName, text: document.getText(), offset };
    const documents = vscode.workspace.textDocuments
      .filter(doc => doc.isDirty && doc.uri.scheme === 'file' && cSource.test(doc.fileName) &&
        vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.toString() === folder.uri.toString())
      .map(doc => ({ file: doc.fileName, text: doc.getText() }));

    view.description = name;
    view.message = '正在查找调用点…';
    provider.replace([]);
    try {
      await vscode.commands.executeCommand('kernelSource.callers.focus');
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `查找 ${name} 的静态 Callers`,
        cancellable: true
      }, async (_, token) => {
        const cancellation = token.onCancellationRequested(() => search.abort());
        try {
          if (token.isCancellationRequested) {
            search.abort();
          }
          return await findCallers({ root: folder.uri.fsPath, name, origin, documents, signal: search.signal });
        } finally {
          cancellation.dispose();
        }
      });
      if (search.signal.aborted || currentSearch !== search) {
        return;
      }
      const { results, warning, unreadable, localOnly } = result;
      const sites = results.reduce((total, caller) => total + caller.calls.length, 0);
      const scope = localOnly ? '当前 .c 文件的 static 定义' : '当前工作区文件夹';
      view.message = `${scope} · ${results.length} 个候选 caller · ${sites} 处调用`;
      if (warning || unreadable.length) {
        view.message += ' · 部分文件无法读取，详见 Kernel Source Navigator 输出';
        output.appendLine([`查找 ${name}`, warning, ...unreadable].filter(Boolean).join('\n'));
      }
      provider.replace(results);
      return result;
    } catch (error) {
      if (!search.signal.aborted) {
        view.message = '查询失败，详见 Kernel Source Navigator 输出';
        output.appendLine(error.stack ?? String(error));
        vscode.window.showErrorMessage(`查找 ${name} 失败。`);
      }
    } finally {
      if (currentSearch === search) {
        currentSearch = undefined;
        if (search.signal.aborted) {
          view.message = '查询已取消';
        }
      }
    }
  });

  context.subscriptions.push(
    view, provider.change, output, find,
    new vscode.Disposable(() => currentSearch?.abort())
  );
  registerHighlights(context, activeIdentifier);
}

module.exports = { activate };
