# PublishHub 项目长期记忆

## GitHub 仓库
- 仓库地址:https://github.com/romanshakaya698-sys/publish-hub
- 可见性:Public
- 默认分支:main
- 推送流程:在 publish-hub 目录下 `git add -A && git commit -m "..." && git push`
- 仓库内不含登录态、文章记录或本地日志(都已通过 .gitignore 排除)

## 项目目录
- 根目录:publish-hub/
- 启动:`npm start`(端口 3789,后台跑时 PID 在 server.log 头部)
- 平台配置:lib/platforms.js(改这里加新平台;运行时覆盖在 data/settings.json)
- 发布引擎:lib/publisher.js(主流程 + 各平台专属如 csdnFillContent/dayuCoverFlow)
- 机器人(发稿+状态合一):lib/bot.js(per-platform persistent context)