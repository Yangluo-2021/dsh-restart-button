# dsh-restart-button

DSH 右上角一个**常驻**按钮：点一下，让整个桌面端（Electron 外壳 + 后台 Host）**优雅关掉再重新打开**。

装插件、换主题、改 `cordis.yml` 之后常常要重启才生效，而这一步以前只能手动退出再点图标。这个按钮把那一步收进界面里，并且尽可能不让你丢掉正在跑的东西。

## 和「杀掉再开」的区别

| | 杀进程重启 | 本插件 |
|---|---|---|
| 关停方式 | `taskkill /F` | 冻结外壳 → 断 IPC → 宿主自己走退出流程（会话落盘、插件 dispose） |
| 正在跑的会话 | 直接没 | 点之前会告诉你几个会话在跑；可选「跑完后重启」 |
| 启动参数 | 丢 | 从原命令行提取，原样带回 |
| 重启后 | 不知道刚才在干嘛 | 新宿主提示「上次重启中断了 N 个会话」 |
| 目标定位 | 按进程名 | 按 pid 校验「主进程 exe + Host 是它的子进程」，校验不过直接放弃 |

## 按钮在哪

`shell.overlay` —— 整个窗口画一次的那层，所以**登录页、空会话页、任何界面右上角都在**（默认距右边 148px、上边 9px，避开 Windows 的最小化/最大化/关闭按钮组）。它不依赖会话视图，这点和挂在会话标题栏的同类插件不同。

## 用法

- **空闲时**点一下：直接重启（默认不弹确认框）。
- **有会话在跑时**点一下：弹确认框，三个选择 —— 取消 / 跑完后重启 / 立即重启。
- 选了「跑完后重启」：卡片会显示已排期，可以随时取消。
- 重启完成后：如果上次有会话被中断，右上角出现一条提示，点「知道了」关掉。

## 安装

从 npm（推荐）：

```bash
# profile 名换成你宿主的 profile；DSH Desktop 一般是 desktop
dsh plugin --profile desktop add @yangluo-2021/dsh-restart-button
```

从本地目录（改源码时）：

```bash
dsh plugin --profile desktop add file:<本目录的绝对路径>
```

装完**重启 DSH** 生效（插件树在启动时合成）。

卸载：

```bash
dsh plugin --profile desktop remove @yangluo-2021/dsh-restart-button
```

DSH Desktop 完全关闭后才能用命令行改 profile：应用的插件管理器在运行期间持有一把 profile 写锁，CLI 不会去动它。

> 本机现在是指向源码目录的 `file:` 安装，**逐文件硬链**：改已有文件立刻生效，**新增文件不会自动同步**（需要补 `ln -f` 或重装）。改完源码仍需重启 DSH 才生效。

## 分享给别人

`dsh plugin` 只是把参数转给 pnpm，pnpm 认识的源都能装。

### 1. 发单个 tgz（推荐）

```bash
npm pack          # 生成 dsh-restart-button-0.6.0.tgz
```

对方：

```bash
dsh plugin --profile desktop add file:<路径>/dsh-restart-button-0.6.0.tgz
```

`.tgz` 只包含 `files` 里列出的内容，比整个目录干净。

### 2. 直接发目录

打包成 zip 发给对方，解压后：

```bash
dsh plugin --profile desktop add file:<解压后目录的绝对路径>
```

### 3. 从 npm 装

```bash
dsh plugin --profile desktop add @yangluo-2021/dsh-restart-button
```

裸名 `dsh-restart-button` 在 npm 上已被别人占用（v0.1.2），所以本包发布在带 scope 的名字下。

### 4. 从 GitHub 装

```bash
dsh plugin --profile desktop add github:Yangluo-2021/dsh-restart-button
```

### 分发前要知道的三条限制

- **仅 Windows**。`package.json` 里声明了 `os: ["win32"]`，macOS / Linux 上 pnpm 直接拒绝安装。
- **仅 DSH Desktop**。插件要求「Electron 的 Node 子进程 + 有 IPC 通道」这个形态；纯 `dsh web` 下按钮会返回 501 并说明原因，不会误杀任何进程。
- 对方的 profile 名不一定是 `desktop`，让他先跑 `dsh plugin --profile <名字> list` 确认。

## 它是怎么重启的

浏览器没有资格开关进程，所以决定权全在宿主（Node）侧。按钮向宿主自己的路由发 POST，宿主再交给一条**能在自己死后继续活下去**的链路：

```
宿主 lib/index.js
  └─ node lib/detach.cjs            ← detached，宿主死了它还活着
       └─ powershell lib/restart-desktop.ps1
            1. 校验：主进程 exe 对得上、Host 是主进程的子进程
            2. 冻结：NtSuspendProcess(主进程)   ← 外壳看不到 Host 离开，不会弹崩溃框
            3. 等：Host 读到 "ready" 后自己 process.disconnect()
                   —— 这是宿主自己的退出流程，会话落盘、插件 dispose
            4. 结束冻结的外壳 + 残留的 Chromium 子进程，等端口释放
            5. Start-Process 原 exe，带上原始命令行参数
            6. 4 秒后确认进程还活着（pid 不等于窗口），再尽力把窗口叫到前台
```

中途任何一步失败，只要外壳已被冻结，都会先 `NtResumeProcess` 把它解冻，绝不留下一个冻住的应用。

### 三个踩过的坑（都是实测出来的）

**① 启动时的环境变量。** DSH Desktop 的 Node 宿主自带 `ELECTRON_RUN_AS_NODE=1`（应用用它启动自己的后端）。任何从这里启动的进程都会继承它，而**带着它启动的应用会退化成纯 Node：没有窗口、不开端口、一秒内无声退出**。这就是早期版本「点了按钮只关了、没重新打开」的全部原因。现在 `launchEnv()` 剔掉 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` 等，PowerShell 侧再剔一次。

**② 不能给启动应用的那次调用加 `windowsHide`。** Node 会把它翻译成 `STARTUPINFO.wShowWindow = SW_HIDE`，Windows 把这个状态应用到新进程的**第一个窗口**——对 Electron 就是主窗口。现象：进程在、端口在听、`tasklist` 有窗口标题，屏幕上什么都没有。实测 `MainWindowHandle`：带该选项 6 个进程全为 0，不带则非 0。所以 `Start-Process` **不加 `-WindowStyle`**；而 detach.cjs 里的 `windowsHide: true` 只作用于 PowerShell 的控制台，够不到应用。

**③ PowerShell 不能直接 detached 启动。** 带 `DETACHED_PROCESS` 的 PowerShell 没有控制台可挂，立刻退出；不 detached 又会被放进父进程的 kill-on-close job，跟着宿主一起死。所以中间必须有 `detach.cjs` 这一层：它自己 detached，再以普通子进程（隐藏控制台）拉起 PowerShell。

### 为什么不用端口判断「起来了」

DSH 每次启动绑一个**随机端口**，「旧端口恢复监听」永远等不到。判断只能看进程，而且要**看两次**：启动期就崩的进程会先留下一个 pid 再消失。

## 请求校验

只接受来自本机、且浏览器没标成跨站的请求：对端必须是回环地址，前面不能有 `forwarded` / `x-forwarded-for` / `x-real-ip` 之类代理头，`sec-fetch-site` 不能是 `cross-site`。

`Origin` **不参与判断**。DSH Desktop 用自定义协议提供页面，它的 origin 是 `dsh-app://…` 这种没有可比 authority 的形态，早期版本拿它比对 HTTP 的 `Host`，结果把应用自己的每一次点击都拒成了 403。

`POST` 还要求 `application/json`，跨站表单拿不到这个 content-type 而不触发预检。

## 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-restart-button/status` | 有几个会话在跑、上次重启中断了什么、当前策略 |
| GET | `/dsh-restart-button/capabilities` | 装的是哪个版本、模式是什么（健康探针） |
| POST | `/dsh-restart-button/restart` | `{when:"now"}` 立即重启；`{when:"idle"}` 等跑完 |
| POST | `/dsh-restart-button/cancel` | 取消已排期的重启 |
| POST | `/dsh-restart-button/resume-ack` | 关掉「上次中断了 N 个会话」的提示 |

## 配置

在 profile 的 `cordis.patch.yml` 里给这条 entry 加 config：

```yaml
- id: dsh-restart-button
  config:
    confirm: when-busy      # when-busy（默认）| always | never
    allowRestart: true      # false 时只显示按钮但拒绝执行
```

按钮位置写在 `client/client.js` 的 `INSET_RIGHT` / `INSET_TOP`；无边框构建可以把它调到 `12`。

## 日志

`~/.dsh/logs/dsh-restart-button.log` —— 每一次重启的每一步都在里面，一眼能看出停在哪（`verified` / `ready suspended` / `host exited on its own` / `restart complete`）。

## 自检

```bash
node scripts/smoke.mjs     # 离线：两端注册、校验规则、忙闲判定、排期器、组件渲染
node scripts/e2e.mjs       # 真实：启动应用 → 打一次重启 → 验证新进程/新端口/窗口可见/走了优雅路径
node scripts/ui-check.mjs  # 真实：用 CDP 进渲染进程，量按钮位置、走一遍确认框（不会重启）
```

- `smoke.mjs` 跑在假宿主上，**不会**触发重启：唯一能走到重启分支的用例，因为进程不是桌面端而被 501 拦下，末尾还会核对日志证明没有进程被拉起。
- `e2e.mjs` / `ui-check.mjs` / `panel-check.mjs` 顶部写死了本机 DSH 的安装路径（`EXE` 常量），换机器先改这一行。
- `e2e.mjs` **会真的把应用关掉再打开**。别在自己正在干活的会话里跑。
- `ui-check.mjs` 会以 `confirm: always` 的临时配置启动应用并点击按钮，只会打开/关闭确认框；跑完记得把 `cordis.patch.yml` 里那段临时配置删掉。

## 已知限制

- 「上次中断了 N 个会话」只是**告知**，不会自动替你点「继续」——自动续跑需要往会话里注入消息，属于另一个层面的耦合，这里没做。
- 只有 `interrupted` 非空的记录才会提示；纯粹重启一次不打扰你。
- 外壳被冻结期间它自己的窗口状态（尺寸、位置）来不及落盘，这是换取「不弹崩溃框」的代价。
