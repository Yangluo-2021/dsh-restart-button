# 发布到 npm + GitHub

这份手册是为「换一台电脑发布」写的。把整个 `dsh-restart-button` 目录（或同名 zip）拷过去，按下面的顺序做即可。

---

## 0. 包里有什么

```
dsh-restart-button/
├── lib/                    # 宿主侧：路由、忙闲判断、detach、PowerShell 关停脚本
├── client/client.js        # 浏览器侧：右上角常驻按钮、确认框
├── cordis.patch.yml        # 把插件插进 profile 的补丁（包名改了这里必须同步改）
├── scripts/                # 自检脚本 + prepare-publish.mjs
├── package.json
├── README.md · LICENSE · PUBLISH.md
└── .gitignore
```

不含 `node_modules`（这个包没有任何运行时依赖）、不含截图和 `.tgz`。

---

## 1. 新电脑装什么

| 东西 | 说明 |
|---|---|
| **Node.js 20+** | 发布只需要 npm；`node -v` 确认 |
| **git** | 推 GitHub 用 |
| **gh**（可选） | 有它能一条命令建仓库；没有就用网页建 |
| **DSH Desktop**（可选） | 只有想验证「装上去能不能用」时才需要 |

检查：

```bash
node -v && npm -v && git --version
```

---

## 2. 改名：一条命令改三个文件

`dsh-restart-button` 这个裸名在 npm 上已被别人占用（v0.1.2，作者 jiqiu0709），所以本包发布在 `@你的npm用户名/dsh-restart-button` 下。

```bash
node scripts/prepare-publish.mjs --npm-user <你的npm用户名> --github-user <你的GitHub用户名>
```

先确认无误可以加 `--dry-run` 只看不写。

它改的三处，**一处都不能漏**：

| 文件 | 改什么 | 漏了会怎样 |
|---|---|---|
| `package.json` | `name` 变 `@user/dsh-restart-button`；补 `repository` / `homepage` / `bugs` / `author`；加 `publishConfig`（锁官方源 + `access: public`） | 发到镜像上、或 scoped 包被当私有拒绝 |
| `cordis.patch.yml` | `name:` 变 `@user/dsh-restart-button` | 装完启动时 **cannot find module**，插件根本加载不了 |
| `README.md` | `@NPM_USER/` 换成真实 scope | 别人照文档装会 404 |

> npm 用户名只能小写。脚本会校验，输大写会直接报错。

---

## 3. 发布到 npm

```bash
npm login --registry=https://registry.npmjs.org
npm publish
```

两个必须注意的：

- **`--registry` 不能省。** 你这台机器的 npm 默认源很可能是 `registry.npmmirror.com`（淘宝镜像），镜像是只读的，往它发布一定失败。登录和发布都要在官方源上。
- **`--access public` 不用手动加**：第 2 步已经写进 `publishConfig`。scoped 包默认被当成私有，不加会报 402。

验证：

```bash
npm view @<用户名>/dsh-restart-button version
# 应输出 0.6.0
```

刚发布完的 1～2 分钟内，某些镜像和 `npm view` 可能还没同步，属正常。

---

## 4. 推到 GitHub

有 `gh`：

```bash
git init
git add -A
git commit -m "dsh-restart-button 0.6.0"
gh repo create dsh-restart-button --public --source=. --push
```

没有 `gh`，就在网页上建一个空仓库（不要勾 README / .gitignore），然后：

```bash
git init
git add -A
git commit -m "dsh-restart-button 0.6.0"
git remote add origin https://github.com/<用户名>/dsh-restart-button.git
git branch -M main
git push -u origin main
```

第一次 push 会弹浏览器让你登录 GitHub（Git Credential Manager），登录一次之后就不用再登。

> 仓库名可以就叫 `dsh-restart-button`，和 npm 包名带 scope 不冲突。

---

## 5. 验证「装上去真的能用」

```bash
dsh plugin --profile desktop add @<用户名>/dsh-restart-button
```

装完**重启 DSH**（插件树在启动时合成），右上角应该出现圆形箭头按钮。

卸载：

```bash
dsh plugin --profile desktop remove @<用户名>/dsh-restart-button
```

---

## 6. 报错对照表

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `403 Forbidden` / `must verify email` | npm 邮箱没验证 | 去 npm 网站点验证邮件 |
| `402 Payment Required` | scoped 包被当私有 | 确认 `publishConfig.access = "public"`，或手动 `npm publish --access public` |
| `409 Conflict` / `cannot publish over` | 这个版本号已经发过 | 改 `version` 再发；npm 不允许覆盖已发布版本 |
| `404 Not Found` 安装时 | 装的人指向了镜像，或包名打错 | 让对方 `dsh plugin add @user/dsh-restart-button`，并确认源 |
| 装上了但右上角没按钮 | `cordis.patch.yml` 的 `name` 还是裸名 | 回第 2 步重跑脚本 |
| 启动日志 `cannot find module 'dsh-restart-button'` | 同上 | 同上 |
| macOS / Linux 装不上 | `package.json` 声明了 `os: ["win32"]` | 预期行为，这个插件只支持 Windows |

---

## 7. 以后发新版本

```bash
npm version patch        # 或 minor / major，会自动 bump 并打 git tag
npm publish
git push --follow-tags
```

`npm version` 会改 `package.json` 的版本号并提交，省得手改。

---

## 8. 已知的本机依赖

`scripts/e2e.mjs`、`scripts/ui-check.mjs`、`scripts/panel-check.mjs` 顶部把 DSH 的安装路径写死成了本机路径（`EXE` 常量）。它们只是自检脚本，**不影响发布**；换机器后想跑，先改那一行。
