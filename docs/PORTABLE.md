# EasyAG 便携版说明（Windows x64）

EasyAG 当前只发布 Windows 10/11 x64 便携包，不需要安装 Node.js、Rust 或 Python。

## 安装

1. 从 [Releases](https://github.com/zengzengbin/EasyAG/releases/latest) 下载 `EasyAG-v4.1.0-windows-x64.zip`。
2. 解压到可写目录，例如 `D:\EasyAG`，不要直接在压缩包里运行。
3. 确认 `EasyAntigravity.exe`、`WebView2Loader.dll`、`easyag-node.exe`、`backend\` 在同一目录。
4. 双击 `EasyAntigravity.exe`。

系统需要 Microsoft Edge WebView2 Runtime；大多数 Windows 10/11 已自带，缺失时从 [微软官网](https://developer.microsoft.com/microsoft-edge/webview2/) 安装。

发布包未做代码签名，SmartScreen 提示时选择“更多信息 → 仍要运行”。只从本仓库 Releases 下载，并核对发布说明里的 SHA-256。

## 使用

- 选择桌面版或 IDE 版，点击“启动 Antigravity”。
- 选择代理端口，或关闭“免 TUN 进程代理”使用直连；EasyAG 不提供代理节点。
- 在 Antigravity 登录账号后，回到 EasyAG 点击“保存当前”。
- 添加账号：点击“添加账号”，按引导登录另一个账号并保存。
- 切换账号：点击账号行的 `⇄`；Antigravity 会先关闭，再以新凭证重启。
- 修改别名/备注：`✎`；导出档案：`↗`（含凭证，勿分享）；删除档案：`×`。
- 汉化、上下文圆环只在 Antigravity 由 EasyAG 启动时生效。已有 Antigravity 进程时，使用“清理并重新启动”。

关闭窗口只会隐藏到托盘，不会退出；彻底退出请右键托盘图标选择“退出应用”。EasyAG 退出不会强制关闭其他 Antigravity 进程。

## 用户数据

- 设置、日志、账号档案：`%LOCALAPPDATA%\com.easyag.launcher.tauri\`
- 账号档案由 Windows DPAPI 以当前用户身份加密；明文头不含 token。
- 升级程序不需要删除用户数据；卸载时可手动删除上述目录。

## 额度窗口

额度看板已按作者决定移除，当前版本不展示额度、不请求额度接口、不生成额度缓存。需要查看额度请直接使用 Antigravity 界面。

## 安全与风险

- EasyAG 只操作本机凭证，不做额度池化、token 中继、自动换号或多开。
- 多账号轮换仍可能违反 Google 服务条款，存在账号风险；请只使用自己的账号。
- 导出 JSON 是明文凭证格式，必须安全保管。
