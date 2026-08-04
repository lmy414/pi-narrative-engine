# 应用形态说明

> 状态：已更新（2026-08-04，pure-SDK 转型后）
> 历史：本文档原名「应用内置模式安装指南」（v0.1.0-alpha.1），描述 Tauri 应用 + 扩展快照/重装链路。
> **该链路已随 pure-SDK 转型整体删除**（扩展机制废弃：无 `.pi/extensions/`、无 `launch-pi`、无 `extension-snapshot`、无 `reinstall` 端点）。
> 原 560 行内容不再适用，保留本说明作为形态记录；Tauri 桌面分发为第二阶段 G6 待办。

---

## 一、当前运行形态（唯一现行）

narrative-engine 是**基于 pi SDK 的独立应用**，不依赖 pi 本体运行：

```bash
node scripts/app-server.mjs [--project <dir>] [--port 7421]
```

- 浏览器访问 `http://127.0.0.1:7421` 使用全部功能（项目管理/世界图/事件链/创作编排/调试/文件/设置）
- LLM 配置：设置页「模型配置」5 slot（default/planner/role/reasoning/renderer），持久化到 `%APPDATA%/narrative-engine/`
- 会话与运行时数据落在项目目录 `.pi/` 下

## 二、已废弃的历史链路（2026-08-01 转型删除）

| 废弃机制 | 说明 |
|---|---|
| 项目级扩展 `.pi/extensions/narrative-engine/` | 引擎不再作为 pi 扩展安装；每项目一份 node_modules 的重复布局已废 |
| `npm run sync` | 扩展同步机制删除 |
| Tauri 应用内置扩展快照（extension-snapshot / reinstall） | 应用内置模式的扩展复制+重装端点删除 |
| `launch-pi`（应用内启动 PI CLI 创作） | 主会话改为 SDK 直连（MainSessionHost），无需启动 pi 进程 |
| 全局扩展目录 `%APPDATA%\narrative-engine\extensions\` | 不再使用；`%APPDATA%/narrative-engine/` 仅存应用配置 |

## 三、Tauri 桌面分发（待办，第二阶段 G6）

- 打包链路（sidecar）尚未验证完成：M-Collab-6（sidecar stdio 泄漏风险）、M29（prebuild 不触发）待处理
- 跨平台（macOS/Linux）未实测
- 版本发布（0.1.0-alpha.1 → 正式版）在 G6 排期

## 四、端口与环境

- 缺省端口 7421（`NE_PORT` 或 `--port` 覆盖）
- 服务只监听 127.0.0.1；恶意 Origin 请求返回 403（2026-08-03 安全加固）
