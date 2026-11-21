# EasyAG v4.1.0（Windows x64）

EasyAG 的首个公开 Windows 便携版。基于 MIT 开源的 EasyAntigravity 二次开发，聚焦多账号切换、可逆汉化和本地启动增强。

## 本次包含

### 多账号

- Windows DPAPI 加密的账号档案（token 不落明文）。
- 一键切换账号：停净 Antigravity → 写回凭证 → 自动重启。
- 账号别名、备注、最近使用时间。
- 账号档案导入/导出（导出文件含凭证，请勿分享）。
- 兼容 AG 2.33 起不再写 `id_token_email` 的凭证格式。

### 启动与界面

- 免 TUN 进程代理，支持 7890 / 7897 / 10808 和自定义端口。
- 桌面版 / IDE 版启动目标切换。
- 可逆中文界面翻译（桌面版，CDP 注入）。
- 只读上下文圆环与输出速度详情。
- 进程冲突清理与重新启动。

### 维护

- AG 日志自动清理（仅 AG 未运行时，删除超过 64MB 的 `.log`）。
- 系统托盘驻留。
- 自编译 Tauri 原生壳，Windows x64 便携包。

## 明确不包含

- 额度看板 / 额度窗口（已移除，不请求额度接口）
- 自动换号 / 额度池化
- token 直连 Google / 多账号 API 中继
- 自动更新 / 热更新
- macOS / Linux

## 下载与安装

下载 `EasyAG-v4.1.0-windows-x64.zip`，解压后运行 `EasyAntigravity.exe`。必须保留同目录的 `WebView2Loader.dll`、`easyag-node.exe` 和 `backend\`。

系统要求：Windows 10/11 x64、Microsoft Edge WebView2 Runtime。

## 安全提示

- 发布包未做代码签名，SmartScreen 可能提示未知发布者；请核对 SHA-256。
- 多账号轮换可能违反 Google 服务条款，存在账号风险；请只使用自己的账号。
- EasyAG 不提供代理节点、不共享账号、不上传凭证。

## 校验

SHA-256（zip）：见 GitHub Release 页面。

## 致谢

- 上游：https://github.com/DSDS-CMHL/EasyAntigravity （MIT）
- 汉化词典与上下文监控参考见 README 致谢。
