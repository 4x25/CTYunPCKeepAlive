# 2026-08-29 Bundle Snapshot

本目录保存 2026-08-29 梳理天翼量子 AI 云电脑、IAM 账号中心和云智助手接口时实际下载、检索或分析过的前端资源快照。

## 快照信息

| 项目 | 值 |
| --- | --- |
| 下载完成时间 | `2026-08-29T11:28:34Z` |
| 文件数量 | 37 |
| 总大小 | 11,454,402 bytes |
| PC 云电脑资源 | 19 个文件 |
| IAM 资源 | 9 个文件 |
| 云智助手资源 | 9 个文件 |
| 完整校验表 | [`SHA256SUMS`](./SHA256SUMS) |

下载后的文件未格式化、未反混淆、未修改，保留服务器返回的原始字节。

## 目录与来源

### `pc-cloud-desktop/`

除以下特殊文件外，目录中的文件均来自：

```text
https://deskcdn.ctyun.cn/pccdnstatic/js/<filename>
```

特殊文件：

```text
main.1786325516962.js
https://pc.ctyun.cn/static/common/main.1786325516962.js
```

该目录覆盖登录、退出、加密协商、设备列表和页面异步加载时盘点到的脚本。

### `iam/`

JS 文件来自：

```text
https://desk.ctyun.cn/cloudB/dy/iam/js/<filename>
```

入口和配置文件：

```text
index.html
https://desk.ctyun.cn/cloudB/dy/iam/

config.js
https://desk.ctyun.cn/cloudB/dy/iam/config.js?v=3.1.1
```

该目录覆盖 IAM 账号密码登录、设备标识、密码摘要、验证码分支和登录路由。

### `eaichat/`

目录中的文件均来自：

```text
https://eaichat.ctyun.cn/chat/js/<filename>
```

该目录覆盖 IAM ticket 换取平台会话、退出登录、请求签名、AI 对话 SSE 解析和 `tools` 兼容性处理。

## 关联文档

- [天翼量子 AI 云电脑账号登录与退出登录接口](../../ctyun-account-auth-api.md)
- [天翼量子 AI 云电脑与 AI 云手机列表接口](../../ctyun-ai-device-list-api.md)
- [天翼云智助手账号登录与退出登录接口](../../ctyun-eaichat-account-auth-api.md)
- [天翼云智助手 AI 对话 SSE 接口](../../ctyun-eaichat-chat-sse-api.md)

## 完整性验证

本次重新从源 URL 下载后，与接口分析期间保留在临时目录中的副本逐文件执行字节比较，37/37 完全一致。

校验快照：

```bash
cd docs/bundle-snapshots/2026-08-29
shasum -a 256 -c SHA256SUMS
```

`SHA256SUMS` 中的路径均相对于本目录。

## 安全边界

该快照只包含公开网页静态资源，没有保存浏览器 Cookie、账号、密码、密码摘要、IAM ticket、会话密钥、请求签名、用户 ID、租户 ID 或设备 ID。
