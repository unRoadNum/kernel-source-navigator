# Kernel Source Navigator

在 VS Code 里浏览未编译的 Linux 内核 C 源码。

## 使用

用 **打开文件夹** 打开内核源码根目录。在 `.c` 或 `.h` 中把光标放在标识符上，使用编辑器右键菜单。

- **查找静态 Callers** 在资源管理器的 **Kernel Callers** 中按外层函数列出调用点。单击只有一处调用的结果直接跳转。有多处调用时展开函数查看各调用点。
- **切换全局标识符高亮** 给整个工作区里已显示和之后打开的 `.c`、`.h` 文件标出同名词。可同时标记多个名称，重开工作区后恢复。再次执行可取消该名称，命令面板中的 **Kernel Source: 清除全部高亮** 可一次清除。

## 查询范围

每次查询由 ripgrep 扫描当前文件所属工作区文件夹，再由 Tree-sitter C 从候选文件提取形如 `foo(...)` 的调用和所在函数。查询使用已打开文件的未保存编辑。若在 `.c` 的函数定义上识别到 `static`，查询限定本文件。结果是源码级候选。同名函数、条件编译和函数指针可能影响结果，宏展开和回调绑定不参与解析。高亮按完整词匹配，注释、字符串和同名局部变量也会着色。

## 构建

在 Windows x64 上用 Node.js 22 或以上版本运行。VSIX 自带 ripgrep 和 C 语法的 WASM 文件，运行时只读取本地源码。

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run package:windows
code --install-extension ./kernel-source-navigator-0.1.0-win32-x64.vsix
```
- npm.cmd ci --ignore-scripts 按 package-lock.json 安装依赖，并跳过依赖的安装脚本。
- npm.cmd run package:windows 生成 Windows x64 的 .vsix 安装包。
给其他电脑装现成插件，只需要复制 .vsix，然后在 VS Code 里执行 Install from VSIX。目标电脑无需安装 Node.js 或 npm。第一行末尾的 \ 可以去掉，两条命令分别执行。