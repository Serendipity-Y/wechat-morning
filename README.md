# 专属早安 · 微信小程序

我做这个模块，是想让伴侣早上打开微信，就能看到一句问候、今天的天气和穿搭建议。平时也可以把想一起做的事、见面的愿望和生活里的小事记下来。

这个仓库是早安模块的独立示例。它使用微信原生小程序和云开发，内置虚构内容和示例城市，可以在自己的小程序和云环境中配置。

## 功能

- **每日早安**。展示天气预报、穿搭建议、当天称呼和早安文案。同一天的页面和提醒复用当天的问候。
- **两人空间**。主人可以邀请一位伴侣绑定。两人都可以编辑记忆碎片、见面愿望和专属小事。邀请和提醒由主人管理。
- **微信提醒**。伴侣可以预约次日提醒。每次接受一次性订阅授权，对应一条微信通知。启用提醒且有可用次数时，云函数会在配置的时刻尝试发送。微信接口确认发送成功后，云函数扣减一次本地记录的额度。 [腾讯云订阅消息说明](https://cloud.tencent.com/document/product/1301/103770)

## 自建

### 微信小程序与云环境

1. 在微信开发者工具导入本仓库根目录。在 `project.config.json` 中用自己的小程序 AppID 替换 `touristappid`，在 `miniprogram/app.js` 中用自己的云环境 ID 替换 `YOUR_CLOUD_ENV_ID`。
2. 在云开发控制台创建 `appUsers`、`morningSettings`、`morningInvites`、`morningDaily` 四个集合。将集合设置为禁止小程序客户端直接读写；各页面通过云函数访问。云存储中的邀请二维码也应保持私有，由云函数生成临时访问地址。
3. 在自己的环境部署 `getOpenId` 和 `morningService`，使用支持当前 SDK 的 Node.js 运行时，例如 Node.js 20，并安装目录内依赖。生成邀请二维码要求给 `morningService` 配置 `wxacode.getUnlimited` 权限。
4. 用准备作为主人的微信账号打开开发版，在开发者工具控制台调用 `getApp().getOpenId()`，私下查看该账号的返回值。云环境管理员在 `appUsers` 创建且只创建一条活跃主人记录，字段为 `openid`（该返回值）、`role`（`owner`）、`status`（`active`）。重新打开小程序后进入管理页。
5. 主人在管理页生成邀请，用第二个微信账号扫码或粘贴 24 位绑定码完成绑定。开发版或体验版调试二维码时，在 `morningService` 设置 `MINI_PROGRAM_VERSION` 为 `develop` 或 `trial`。正式版默认使用 `release`。

示例天气城市、坐标和纪念日集中在 `cloudfunctions/morningService/index.js` 的 `FIXED_SETTINGS`。首次绑定会建立设置文档。调整固定设置后，部署更新并在主人管理页保存一次，让提醒函数也读取新设置。

### 配置微信提醒

1. 在微信公众平台获取适用于自己小程序的**一次性订阅模板**。将模板 ID 写入 `morningSettings` 中该主人的唯一设置文档的 `templateId` 字段，并把 `reminderEnabled` 设为 `true`。发送端示例使用 `time1`、`thing2` 和 `thing3`，按实际模板调整 `cloudfunctions/sendMorningReminder/index.js` 中的 `messageData`。
2. 部署 `sendMorningReminder`，在该函数的环境变量配置 `MINI_PROGRAM_APP_ID` 和 `MINI_PROGRAM_APP_SECRET`。开发版或体验版测试消息跳转时，在该函数也设置对应的 `MINI_PROGRAM_VERSION`。
3. 用伴侣账号完成一次订阅授权，再在管理页分别检查条件、发送一条测试消息和验证跳转。手动测试会消耗一次可用额度。
4. 通过云开发控制台配置 `sendMorningReminder` 的定时触发器，按控制台显示的时区核对对应的北京时间 07:30。使用北京时间的七段 Cron 配置为 `0 30 7 * * * *`。函数要求平台提供 `TRIGGER_SRC=timer`；使用定时器运行记录确认实际触发和发送结果。 [云开发定时触发器](https://docs.cloudbase.net/cloud-function/timer-trigger) · [平台内置环境变量](https://docs.cloudbase.net/cloud-function/function-configuration/env)

天气使用 Open-Meteo 日预报。部署时请按服务条款使用接口，并保留天气数据来源署名。 [Open-Meteo 使用条款](https://open-meteo.com/en/terms)

## 代码与验证

| 路径 | 用途 |
| --- | --- |
| [miniprogram/pages](miniprogram/pages/) | 角色入口、绑定、早安首页、管理和三栏详情 |
| [cloudfunctions/morningService](cloudfunctions/morningService/) | 校验角色、生成邀请、提供早安内容和记录订阅 |
| [cloudfunctions/sendMorningReminder](cloudfunctions/sendMorningReminder/) | 定时提醒与发送状态 |
| [cloudfunctions/shared/morningContent.js](cloudfunctions/shared/morningContent.js) | 虚构问候样例，更新时同步到两个云函数目录 |

在根目录安装两组离线测试依赖并执行测试：

```sh
npm ci --prefix cloudfunctions/morningService
npm ci --prefix cloudfunctions/sendMorningReminder
npm test
```

离线测试覆盖角色与绑定决策、内容编辑、页面回退、天气快照和提醒防重入。自建环境仍需验证开发者工具编译、云函数权限、真实微信订阅及定时器。

当前锁定的微信服务端 SDK 仍包含 npm 审计报告中的高风险传递依赖。用于公开示例和隔离测试环境，实际部署前请复核依赖公告与平台权限。

## 数据与许可

账号标识、邀请、记忆和发送记录保存在自己部署的云环境里。提 issue 或分享截图时，请使用测试账号和虚构内容，避免公开邀请、账号标识、模板 ID 或密钥。

代码采用 [MIT 许可证](LICENSE)。第三方依赖及天气数据按各自条款使用。
