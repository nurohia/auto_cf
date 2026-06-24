# Atuo CF 优选解析面板

一个基于 `XIU2/CloudflareSpeedTest` 的多域名 Cloudflare DNS 自动优选面板。

## 功能

- 添加多个要优选的解析域名
- 区分“要优选的域名”和“解析到的域名”
- Cloudflare Zone ID 和 DNS Record ID 自动查询
- DNS 记录不存在时自动创建
- 支持 A / AAAA 记录
- 支持按秒、分钟、小时、天设置定时优选
- 支持手动立即优选
- 支持 Cloudflare API Token 加密存储
- 支持运行日志和成功/失败状态

## 启动

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:5100
```

## CloudflareSpeedTest

把测速程序放到：

```text
bin/cfst
```

或者启动时指定：

```bash
CFST_BIN=/path/to/cfst npm run dev
```

新增任务时有两个域名概念：

```text
要优选的域名：CloudflareSpeedTest 测速用的目标域名或测速 URL
解析到的域名：最终要被更新 A / AAAA 记录的 Cloudflare DNS 域名
```

如果“要优选的域名”只填纯域名，例如：

```text
speed.example.com
```

程序会自动传给 CloudflareSpeedTest：

```text
-url https://speed.example.com/cdn-cgi/trace
```

如果你想用自己的测速文件，可以直接填完整 URL：

```text
https://speed.example.com/100mb.bin
```

## Cloudflare Token 权限

建议创建 API Token，而不是使用 Global API Key。权限至少包含：

```text
Zone:Read
DNS:Edit
```

作用范围选择对应域名所在 Zone 即可。

面板也兼容 Cloudflare Global API Key。选择 `Global API Key` 鉴权方式时，需要同时填写：

```text
Cloudflare 邮箱
Global API Key
```

API Token 模式会使用 `Authorization: Bearer <TOKEN>`；Global API Key 模式会使用 `X-Auth-Email` 和 `X-Auth-Key`。

## 数据文件

运行后会生成：

```text
.data/db.json
.data/secret
```

Token 会使用 `.data/secret` 派生密钥加密保存。迁移数据时请一起迁移 `.data/secret`。

## Debian 一键部署

在服务器上进入项目目录后运行：

```bash
sudo bash deploy.sh install
```

也可以直接远程安装：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/nurohia/auto_cf/main/deploy.sh)
```

执行后会进入菜单，选择 `1` 安装。安装完成会显示管理员密码，密码也会保存到：

```text
/opt/auto_cf/.data/admin-password
```

默认部署到：

```text
/opt/auto_cf
```

默认服务名：

```text
auto-cf
```

安装脚本会默认自动安装 CloudflareSpeedTest 到：

```text
/opt/auto_cf/bin/cfst
```

安装和更新项目时会自动检查并安装 CloudflareSpeedTest。

如果你的服务器访问 GitHub release 不稳定，可以指定下载直链：

```bash
curl -fsSL https://raw.githubusercontent.com/nurohia/auto_cf/main/deploy.sh | sudo CFST_DOWNLOAD_URL=https://example.com/CloudflareSpeedTest.tar.gz bash -s install
```

只有在你明确不想自动安装 CFST 时才使用：

```bash
curl -fsSL https://raw.githubusercontent.com/nurohia/auto_cf/main/deploy.sh | sudo SKIP_CFST=true bash -s install
```

常用命令：

```bash
bash deploy.sh menu
bash deploy.sh status
bash deploy.sh logs
sudo bash deploy.sh update
sudo bash deploy.sh restart
sudo bash deploy.sh uninstall
```

自定义端口或目录：

```bash
PORT=8080 APP_DIR=/opt/auto_cf bash deploy.sh install
```
