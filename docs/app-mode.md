# 应用内置模式安装指南

> 状态：已实施（v0.1.0-alpha.1）
> 最后更新：2026-07-30
> 适用版本：0.1.0-alpha.1

---

## 一、什么是应用内置模式

narrative-engine 提供两种扩展安装模式：

- **项目级 sync 模式**（开发者模式）：克隆 `narrative-engine` 仓库 → `npm install` → `npm run build` → `npm run sync`，把扩展复制到目标小说项目的 `.pi/extensions/narrative-engine/`，每个项目各持一份 `node_modules`。要求用户具备命令行能力,并自行解决 better-sqlite3 等原生模块的编译环境。
- **应用内置模式**（终端用户模式）：安装 Tauri 桌面应用后,应用首次启动时把内置扩展快照复制到平台应用数据目录并跑 `npm install --omit=dev`,启动 PI 时用 `--no-extensions -e <globalPath>` 显式加载,屏蔽 PI 自动发现,避免与项目级扩展重复加载。

### 1.1 两种模式的核心差异

| 维度 | 项目级 sync 模式 | 应用内置模式 |
|---|---|---|
| 安装位置 | 每个小说项目的 `.pi/extensions/narrative-engine/` | 平台应用数据目录(Windows `%APPDATA%\narrative-engine\extensions\narrative-engine\`) |
| 扩展加载方式 | PI 自动发现 `.pi/extensions/` | `pi --no-extensions -e <globalPath>` 显式加载 |
| 升级方式 | `git pull` + `npm run build` + `npm run sync` | 应用内"重装扩展"按钮或 `POST /api/admin/extension/reinstall` |
| node_modules | 每项目一份(重复占空间) | 全局一份(多项目共享) |
| 适用人群 | 引擎开发者 | 终端用户 |
| 命令行要求 | 必须使用命令行 | 仅启动 PI 时需命令行(应用双击即用) |

### 1.2 全局扩展默认路径

引自 `packages/admin/src/app-config.ts::defaultGlobalExtPath`:

| 平台 | 默认路径 |
|---|---|
| Windows | `%APPDATA%\narrative-engine\extensions\narrative-engine` |
| macOS | `~/Library/Application Support/narrative-engine/extensions/narrative-engine` |
| Linux | `~/.config/narrative-engine/extensions/narrative-engine` |

> 本版本(0.1.0-alpha.1)仅打包 Windows NSIS 安装器,macOS/Linux 路径供后续版本参考。

---

## 二、安装 Tauri 应用

### 2.1 下载安装包

下载 `narrative-engine_0.1.0-alpha.1_x64-setup.exe`(Windows NSIS 安装器)。本版本仅提供 Windows x64 安装器,macOS/Linux 暂未打包。

### 2.2 安装后资源目录布局

引自 `tauri-app/src-tauri/tauri.conf.json` 的 `bundle.resources` 映射与 `scripts/package-sidecar.mjs` 的输出:

```
resources/runtime/**/*  →  runtime/
resources/server/**/*   →  server/
```

应用安装目录下的资源布局(对应 `sidecar.rs::spawn_prod` 读取的 `resource_dir`):

```
<安装目录>/
└── resources/
    ├── runtime/
    │   └── node.exe                    # 内置 Node 运行时(复制自打包机的 process.execPath)
    └── server/
        ├── main.js                     # esbuild 打包产物(src + @pi/* 子包 TS 全内联)
        ├── package.json                # server 依赖清单(原生三件套 + @xenova/transformers)
        ├── node_modules/               # 运行时依赖(npm install --omit=dev 生成,含原生模块)
        ├── visualizer-ui/              # 前端静态资源
        ├── templates/                  # 规则集模板(novel 模板)
        └── extension-snapshot/         # 扩展快照(reinstall 端点的安装源)
            ├── dist/                   # 扩展构建产物
            ├── packages/               # @pi/* 子包源码
            ├── visualizer-ui/
            ├── templates/
            └── package.json
```

> `extension-snapshot/` 是 `reinstall` 端点的安装源,不是 PI 直接加载的扩展目录。PI 实际加载的是 `%APPDATA%\narrative-engine\extensions\narrative-engine\`(重装后才有)。

### 2.3 启动应用

启动流程(引自 `tauri-app/src-tauri/src/lib.rs` 与 `sidecar.rs`):

1. 双击应用图标 → Rust 入口 `lib.rs::run` 启动 Tauri 主进程
2. `setup` 钩子调用 `sidecar::spawn_sidecar(resource_dir)`:
   - 生产模式(`NE_SIDECAR=prod` 或 release 构建):`<resource_dir>/runtime/node.exe <resource_dir>/server/main.js --port 7421`
   - 开发模式(`NE_SIDECAR=dev` 或 debug 构建):`node node_modules/tsx/dist/cli.mjs src/app/main.ts --port 7421`(本场景不适用)
3. sidecar 启动失败不 panic,降级为存 `None`,由启动页超时提示引导排查(详见第九节)
4. WebView 加载本地启动页(`public/index.html`),启动页 JS 轮询 `http://127.0.0.1:7421/` 确认 sidecar 就绪后跳转主界面
5. 应用退出时(`RunEvent::Exit`)kill sidecar 子进程

sidecar 默认端口 `7421`(引自 `sidecar.rs::sidecar_port`),可用环境变量 `NE_PORT` 覆盖;仅监听 `127.0.0.1`。

---

## 三、首次使用:重装扩展

### 3.1 为什么需要重装

应用打包的 `extension-snapshot/` 是源码快照(不含 `node_modules`),PI 不能直接加载。首次使用必须把快照复制到 `%APPDATA%\narrative-engine\extensions\narrative-engine\` 并跑 `npm install --omit=dev` 安装依赖(含 better-sqlite3 / sqlite-vec / onnxruntime-node / @xenova/transformers 等原生模块)。

重装流程引自 `packages/admin/src/app-config.ts::installExtension`:

1. 校验 `snapshotDir/package.json` 存在(否则抛 `SNAPSHOT_INVALID`)
2. `reinstall=true` 时先 `fs.rm(globalExtDir, { recursive: true, force: true })` 清空目标目录
3. 递归复制快照(跳过 `node_modules` 与 `.git`)到 `globalExtDir`
4. 在 `globalExtDir` 跑 `npm install --omit=dev`(Windows 用 `npm.cmd` + `shell: true`)

### 3.2 重装方式一:应用内 UI

打开应用 → 顶部导航切到 **设置** 页 → 找到"扩展管理"区块 → 点击 **重装扩展** 按钮。

按钮触发的 HTTP 请求为 `POST /api/admin/extension/reinstall`,前端在响应返回后刷新扩展版本显示。

### 3.3 重装方式二:HTTP API

**PowerShell(Invoke-RestMethod)**:

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7421/api/admin/extension/reinstall" -ContentType "application/json" -Body "{}"
```

**curl.exe**:

```cmd
curl.exe -X POST http://127.0.0.1:7421/api/admin/extension/reinstall -H "Content-Type: application/json" -d "{}"
```

可选请求体字段:`{ "skipNpmInstall": true }`(仅测试用,跳过 `npm install`,真实流程不可跳过)。

响应(引自 `InstallExtensionResult`):

```json
{
  "ok": true,
  "copiedFiles": 123,
  "npmInstallRan": true,
  "globalExtDir": "C:\\Users\\<you>\\AppData\\Roaming\\narrative-engine\\extensions\\narrative-engine"
}
```

重装成功后,端点会自动更新 `app-config.json` 的 `extension.version`(取自 `globalExtDir/package.json` 的 `version` 字段)与 `extension.lastUpdated`(当前 ISO 时间)。

### 3.4 重装产物

`%APPDATA%\narrative-engine\extensions\narrative-engine\` 的内容(由快照复制 + `npm install` 生成):

```
narrative-engine/
├── dist/                  # 扩展构建产物(从快照复制)
├── packages/              # @pi/* 子包源码(从快照复制)
├── visualizer-ui/         # 前端静态资源(从快照复制)
├── templates/             # 规则集模板(从快照复制)
├── package.json           # 扩展清单(从快照复制)
└── node_modules/          # npm install --omit=dev 生成(含原生模块)
```

### 3.5 验证

调用 `GET /api/admin/extension/update-check`,应返回 `current` 等于已安装版本(与 `package.json` 的 `version` 一致,本版本为 `0.1.0-alpha.1`)。

**PowerShell**:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:7421/api/admin/extension/update-check"
```

**curl.exe**:

```cmd
curl.exe http://127.0.0.1:7421/api/admin/extension/update-check
```

响应(引自 `checkExtensionUpdate` 返回值):

```json
{
  "current": "0.1.0-alpha.1",
  "available": "0.1.0-alpha.1",
  "updateAvailable": false
}
```

> `current` 取自 `globalExtDir/package.json`,`available` 取自 `extension-snapshot/package.json`。两者相等时 `updateAvailable=false`。`current=null` 表示 `globalExtDir` 不存在或 `package.json` 缺失(尚未重装)。

---

## 四、应用级配置

### 4.1 配置文件路径

引自 `packages/admin/src/app-config.ts::getAppConfigPath` 与 `_defaultConfigDir`:

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\narrative-engine\app-config.json` |
| macOS | `~/Library/Application Support/narrative-engine/app-config.json` |
| Linux | `~/.config/narrative-engine/app-config.json` |

文件不存在或字段缺失时,`readAppConfig` 用默认值宽松合并(顶层 key 深层合并)。

### 4.2 字段说明

基于 `AppConfig` 接口(`packages/admin/src/app-config.ts`):

```typescript
{
  "extension": {
    "mode": "enabled",                  // "enabled" | "disabled"
    "globalPath": "<...>",              // 全局扩展安装位置
    "useExplicitFlag": true,            // 是否用 -e 显式加载
    "version": "0.1.0-alpha.1",         // 已安装扩展版本
    "lastUpdated": "2026-07-30T..."     // 最近安装/重装时间 ISO
  },
  "launcher": {
    "piExecutable": "pi",               // PI 可执行文件
    "defaultScanRoots": []              // 项目扫描默认根目录
  },
  "embedder": {
    "model": "Xenova/bge-small-zh-v1.5" // 向量模型(对应 PI_EMBEDDER_MODEL)
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `extension.mode` | `"enabled"` \| `"disabled"` | `"enabled"` | 对应 WebUI 屏蔽扩展开关 |
| `extension.globalPath` | string | `<configDir>/extensions/narrative-engine` | 全局扩展安装位置 |
| `extension.useExplicitFlag` | boolean | `true` | `true`=启动 PI 时用 `-e` 显式加载;`false`=走 PI 自动发现 |
| `extension.version` | string | `""` | 已安装扩展版本(取自 `globalPath/package.json`) |
| `extension.lastUpdated` | string | `""` | 最近安装/重装时间 ISO 字符串 |
| `launcher.piExecutable` | string | `"pi"` | PI 可执行文件,需在 PATH 中或写绝对路径 |
| `launcher.defaultScanRoots` | string[] | `[]` | 项目扫描默认根目录列表 |
| `embedder.model` | string | `"Xenova/bge-small-zh-v1.5"` | 向量模型,对应环境变量 `PI_EMBEDDER_MODEL` |

### 4.3 extension.mode 三档行为

引自 `packages/novel-launcher/src/launch.ts::_buildExtensionArgs` 与 `src/app/routes-ext.ts` 的 `/api/projects/launch-pi` 端点:

| `extension.mode` | `extension.useExplicitFlag` | PI 启动参数 | 行为 |
|---|---|---|---|
| `enabled` | `true`(默认) | `pi --no-extensions -e <globalPath> [args...]` | 屏蔽 PI 自动发现 + 显式加载全局扩展(避免项目级与全局扩展重复加载) |
| `enabled` | `false` | `pi [args...]` | 走 PI 自动发现(`~/.pi/agent/extensions/` 或项目级 `.pi/extensions/`) |
| `disabled` | 忽略 | `pi --no-extensions [args...]` | 屏蔽所有扩展自动发现,PI 纯净模式 |

`launch-pi` 端点构造 `extensionPath` 的逻辑(`routes-ext.ts` 第 307-310 行):

```typescript
extensionPath:
  appConfig.extension.mode !== "disabled" && appConfig.extension.useExplicitFlag
    ? appConfig.extension.globalPath
    : undefined,
```

### 4.4 修改方式

**方式一:应用内 UI**

打开应用 → 设置页 → 编辑应用配置表单(扩展模式 / PI 路径 / 扫描根 / 向量模型),保存即写入 `app-config.json`。

**方式二:HTTP API**

读取配置:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:7421/api/admin/app-config"
```

```cmd
curl.exe http://127.0.0.1:7421/api/admin/app-config
```

整体更新(顶层 key 深层合并):

```powershell
$body = @{ launcher = @{ piExecutable = "C:\path\to\pi.exe" } } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:7421/api/admin/app-config" -ContentType "application/json" -Body $body
```

```cmd
curl.exe -X PUT http://127.0.0.1:7421/api/admin/app-config -H "Content-Type: application/json" -d "{\"launcher\":{\"piExecutable\":\"C:\\path\\to\\pi.exe\"}}"
```

仅切换扩展模式:

```powershell
Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:7421/api/admin/extension/mode" -ContentType "application/json" -Body '{ "mode": "disabled" }'
```

```cmd
curl.exe -X PUT http://127.0.0.1:7421/api/admin/extension/mode -H "Content-Type: application/json" -d "{\"mode\":\"disabled\"}"
```

`mode` 仅接受 `"enabled"` 或 `"disabled"`,其他值返回 `INVALID_MODE` 错误。

---

## 五、项目管理

### 5.1 扫描项目

`GET /api/projects/scan?root=<path>&maxDepth=<n>` — 在指定目录下扫描含 `novel.json` 的小说项目目录。

**PowerShell**:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:7421/api/projects/scan?root=D:\novels&maxDepth=3"
```

**curl.exe**:

```cmd
curl.exe "http://127.0.0.1:7421/api/projects/scan?root=D:\novels&maxDepth=3"
```

`maxDepth` 可选。应用内 UI 在项目管理页提供扫描根输入框,默认根目录来自 `app-config.json` 的 `launcher.defaultScanRoots`。

### 5.2 新建项目

`POST /api/projects/create`,请求体 `{ "dir": "<项目目录>", "name"?: "<标题>", "force"?: true }`。

**PowerShell**:

```powershell
$body = @{ dir = "D:\novels\my-novel"; name = "我的小说" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7421/api/projects/create" -ContentType "application/json" -Body $body
```

**curl.exe**:

```cmd
curl.exe -X POST http://127.0.0.1:7421/api/projects/create -H "Content-Type: application/json" -d "{\"dir\":\"D:\\novels\\my-novel\",\"name\":\"我的小说\"}"
```

`dir` 必填;`name` 缺省取目录名;`force=true` 时覆盖已存在的非空目录。端点调用 `@pi/novel-launcher::createProject`(库化实现,不再 spawn `scripts/init-novel.mjs` 子进程,sidecar 无脚本文件)。

### 5.3 激活项目

`POST /api/projects/activate`,请求体 `{ "dir": "<项目目录>" }`。

**PowerShell**:

```powershell
$body = @{ dir = "D:\novels\my-novel" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7421/api/projects/activate" -ContentType "application/json" -Body $body
```

**curl.exe**:

```cmd
curl.exe -X POST http://127.0.0.1:7421/api/projects/activate -H "Content-Type: application/json" -d "{\"dir\":\"D:\\novels\\my-novel\"}"
```

激活时 `allowInit=true`,新建项目无 `world.db` 时自动初始化空库。同时只激活一个项目;非活跃项目的 WorldGraph 句柄可被 LRU 关闭。

### 5.4 启动 PI 创作

`POST /api/projects/launch-pi`,请求体 `{ "dir": "<项目目录>", "args"?: ["..."] }`。

**PowerShell**:

```powershell
$body = @{ dir = "D:\novels\my-novel" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7421/api/projects/launch-pi" -ContentType "application/json" -Body $body
```

**curl.exe**:

```cmd
curl.exe -X POST http://127.0.0.1:7421/api/projects/launch-pi -H "Content-Type: application/json" -d "{\"dir\":\"D:\\novels\\my-novel\"}"
```

端点按 `app-config.json` 自动拼 PI 启动参数(详见 §4.3 三档行为),用户无需手动指定扩展参数。`args` 数组会追加在扩展参数之后。

Windows 上的启动方式(`launch.ts::_spawnWindows`):`cmd.exe /c start "<title>" cmd.exe /k "<piCmd>"`,新 cmd 窗口继承 cwd 为项目目录,无需 `cd` 命令。

返回 `{ "pid": <number> }`,pid 是中间终端进程的 pid,仅用于确认启动成功,不保证可管理 PI 生命周期。

### 5.5 迁移旧项目

`POST /api/projects/migrate`,请求体 `{ "dir": "<项目目录>" }`。

**PowerShell**:

```powershell
$body = @{ dir = "D:\novels\old-novel" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7421/api/projects/migrate" -ContentType "application/json" -Body $body
```

**curl.exe**:

```cmd
curl.exe -X POST http://127.0.0.1:7421/api/projects/migrate -H "Content-Type: application/json" -d "{\"dir\":\"D:\\novels\\old-novel\"}"
```

迁移流程(`ProjectRegistry::migrateProject`):先备份 `world.db` 再执行 schema 迁移。当激活旧项目返回 `MIGRATION_REQUIRED` 错误时,前端引导用户调用此端点。

---

## 六、升级应用

### 6.1 应用内升级(项目级 sync 模式)

> 注意:此升级路径假定 `repoRoot` 是 git 仓库,适用于**项目级 sync 模式**的开发者。应用内置模式的终端用户应使用 §6.3 的手动升级方式。

`GET /api/admin/update/stream?targetDir=<扩展目录>` — SSE 流式日志,四阶段:`check → pull → build → sync`。

**PowerShell**:

```powershell
$resp = Invoke-WebRequest -Uri "http://127.0.0.1:7421/api/admin/update/stream?targetDir=D:\novels\my-novel\.pi\extensions\narrative-engine" -Headers @{ Accept = "text/event-stream" }
$resp.Content
```

**curl.exe**:

```cmd
curl.exe -N "http://127.0.0.1:7421/api/admin/update/stream?targetDir=D:\novels\my-novel\.pi\extensions\narrative-engine"
```

`targetDir` 缺省为活跃项目的 `.pi/extensions/narrative-engine`。同一时刻只允许一个 update job(单任务守卫 `updateRunning`),重复请求立即以 `error` 事件结束。

应用内入口:设置页 → 检查更新。

### 6.2 重装扩展(应用内置模式)

应用内置模式下,"升级扩展"等价于"重装扩展"(从应用打包的 `extension-snapshot/` 重新复制 + `npm install`),详见 §3.3。先用 `GET /api/admin/extension/update-check` 比对 `current` 与 `available` 版本,不一致时调 `POST /api/admin/extension/reinstall`。

### 6.3 手动升级

1. 重新下载新版本安装包(如 `narrative-engine_0.1.0-alpha.2_x64-setup.exe`)
2. 覆盖安装(应用本体更新,`extension-snapshot/` 同步更新)
3. 启动新版本应用,调 `POST /api/admin/extension/reinstall` 把新快照重装到 `%APPDATA%\narrative-engine\extensions\narrative-engine\`

---

## 七、与项目级 sync 模式共存

### 7.1 不建议混用

应用内置模式下,启动 PI 时会拼 `--no-extensions` 屏蔽 PI 自动发现,因此项目级 `.pi/extensions/` 不会生效。若在同一项目混用两种模式:

- 应用内置模式启动 PI 时,项目级扩展被屏蔽(无声失败,无报错)
- 项目级 sync 模式启动 PI 时(用户在终端手动跑 `pi`),全局扩展不加载(PI 只发现项目级)

### 7.2 如何切换模式

**从应用内置模式切到项目级 sync 模式**:

1. 在应用设置页把 `extension.useExplicitFlag` 改为 `false`(或 `extension.mode` 改为 `disabled`)
2. 在项目目录跑 `npm run sync` 把扩展同步到 `.pi/extensions/narrative-engine/`
3. 此后用终端在该项目目录跑 `pi` 即加载项目级扩展

**从项目级 sync 模式切到应用内置模式**:

1. 在应用设置页把 `extension.useExplicitFlag` 改为 `true`
2. 调 `POST /api/admin/extension/reinstall` 确保全局扩展已安装
3. 删除项目级 `.pi/extensions/narrative-engine/`(可选,避免混淆)
4. 此后通过应用"启动 PI 创作"按钮启动 PI

### 7.3 推荐场景

| 用户类型 | 推荐模式 | 理由 |
|---|---|---|
| 引擎开发者 | 项目级 sync 模式 | 改源码后 `npm run build` + `sync` 即可验证,无需重新打包应用 |
| 终端用户 | 应用内置模式 | 双击即用,无需命令行(除启动 PI 外),扩展升级走应用内重装 |

---

## 八、已知限制

引自 `CHANGELOG.md` 的"已知限制"章节:

1. **仅 Windows**:本版本仅提供 Windows NSIS 安装器(`narrative-engine_0.1.0-alpha.1_x64-setup.exe`);macOS/Linux 暂未打包。
2. **sidecar 内置 Node 运行时与系统 Node 独立**:sidecar 用 `<resource_dir>/runtime/node.exe` 运行,与系统 PATH 中的 Node 版本无关。原生模块(better-sqlite3 / sqlite-vec / onnxruntime-node)按打包时的 Node 大版本编译,跨大版本不兼容(详见 §9.4)。
3. **extension-snapshot 与 globalExtDir 版本不匹配时需手动重装**:应用升级后 `extension-snapshot/` 版本更新,但 `%APPDATA%\narrative-engine\extensions\narrative-engine\` 仍是旧版本。需手动调 `POST /api/admin/extension/reinstall` 重装(可用 `GET /api/admin/extension/update-check` 检测)。
4. **config-ui §三 LLM 配置改造未实施**:LLM 仍走环境变量(`PI_*_API_KEY` / `PI_MODEL` 等,详见 `docs/SETUP.md`),未集成到 `app-config.json`。
5. **跨平台原生模块未验证**:sidecar 打包内的原生模块在 Windows 上验证可用,macOS/Linux 未实测。
6. **`import_novel` / `import_character_card` 为测试实现**:功能链路可用,但实体消解准确性、事件粒度、属性命名一致性、关系抽取完整性均未达生产标准,建议仅用于试验。
7. **可视化既有三页(工作台/事件链/调试)仍用 Element Plus 旧体系**,与新页面(projects/editor/settings/stream)的原型设计体系共存,视觉不统一。

---

## 九、故障排查

### 9.1 sidecar 启动失败

**现象**:应用启动页长时间停留,显示"等待 sidecar 就绪"超时提示。

**排查步骤**:

1. 检查端口 7421 是否被占用:
   ```powershell
   Get-NetTCPConnection -LocalPort 7421 -ErrorAction SilentlyContinue
   ```
   若被占用,可用环境变量 `NE_PORT` 改用其他端口(需重启应用)。
2. 检查应用安装目录下 `<安装目录>\resources\runtime\node.exe` 与 `<安装目录>\resources\server\main.js` 是否存在。`sidecar.rs::spawn_prod` 缺失任一文件会返回清晰错误。
3. sidecar 启动失败不会让应用闪退(`lib.rs::setup` 捕获错误后存 `None`),应用继续运行,启动页超时后显示错误信息。

### 9.2 扩展加载失败

**现象**:启动 PI 后,narrative-engine 的 31 个工具未注册,PI 表现为纯净模式。

**排查步骤**:

1. 检查 `%APPDATA%\narrative-engine\extensions\narrative-engine\node_modules\` 是否存在:
   ```powershell
   Test-Path "$env:APPDATA\narrative-engine\extensions\narrative-engine\node_modules"
   ```
   不存在说明尚未重装扩展,调 `POST /api/admin/extension/reinstall`。
2. 检查 `app-config.json` 的 `extension.mode` 是否为 `"disabled"`:
   ```powershell
   (Get-Content "$env:APPDATA\narrative-engine\app-config.json" | ConvertFrom-Json).extension.mode
   ```
   若为 `disabled`,改为 `enabled`(`PUT /api/admin/extension/mode`)。
3. 检查 `app-config.json` 的 `extension.useExplicitFlag` 是否为 `true`;若为 `false`,PI 走自动发现,需确保扩展已放到 `~/.pi/agent/extensions/`(本应用不会自动放)。
4. 调 `GET /api/admin/extension/update-check` 确认 `current` 非 null:
   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:7421/api/admin/extension/update-check"
   ```
   `current=null` 表示 `globalExtDir/package.json` 缺失,需重装。

### 9.3 PI 启动失败

**现象**:点击"启动 PI 创作"后无新终端窗口弹出,或弹出后立即报错。

**排查步骤**:

1. 检查 `app-config.json` 的 `launcher.piExecutable` 是否指向正确的 pi 可执行文件:
   ```powershell
   (Get-Content "$env:APPDATA\narrative-engine\app-config.json" | ConvertFrom-Json).launcher.piExecutable
   ```
   默认为 `"pi"`,需确保 `pi` 在 PATH 中;否则改为绝对路径(如 `C:\Users\<you>\.cargo\bin\pi.exe`)。
2. 检查目标项目目录是否存在 `novel.json`:
   ```powershell
   Test-Path "D:\novels\my-novel\novel.json"
   ```
3. 检查 `launch-pi` 端点返回的 pid 是否非零。pid 为零或负数表示 spawn 失败(`launch.ts::_spawnNewTerminal` 抛 `SPAWN_FAILED`)。
4. Windows 上若 spawn 报 `EINVAL`,确认 `npm.cmd` 可执行(此问题已在 0.1.0-alpha.1 修复,见 CHANGELOG)。

### 9.4 原生模块崩溃

**现象**:sidecar 启动时报 `better-sqlite3` / `sqlite-vec` / `onnxruntime-node` 模块加载失败,或运行时崩溃。

**原因**:sidecar 内置 Node 运行时(`<resource_dir>/runtime/node.exe`)与原生模块编译时的 Node ABI 版本不匹配。`scripts/package-sidecar.mjs` 在打包时复制当前 `process.execPath` 作为运行时,并用同一 Node 跑 `npm install --omit=dev` 解析原生模块 prebuilt 二进制,两者 ABI 一致。若用户手动替换了 `runtime/node.exe` 或在不同 Node 大版本的环境下重新打包,会触发此问题。

**解决**:在目标平台用目标 Node 大版本重新跑 `node scripts/package-sidecar.mjs` 重新打包,确保 runtime/node 与 node_modules 原生模块 ABI 一致。Windows 产物不可直接分发到 macOS/Linux。

### 9.5 升级后扩展版本不匹配

**现象**:应用升级后,启动 PI 时报扩展工具找不到,或行为异常。

**排查步骤**:

1. 调 `GET /api/admin/extension/update-check`:
   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:7421/api/admin/extension/update-check"
   ```
   若 `updateAvailable=true`(`current !== available`),说明 `extension-snapshot/` 已更新但 `%APPDATA%` 下的全局扩展仍是旧版。
2. 调 `POST /api/admin/extension/reinstall` 重装扩展。
3. 重装后再次 `update-check`,确认 `updateAvailable=false`。
