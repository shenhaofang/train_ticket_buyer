安装 Node.js 20+（x64；用 arm64 机器也选对应架构）。验证：node -v 和 node -p "process.platform + ' ' + process.arch" 应输出 win32 x64 或 win32 arm64。

npm i
node ticket_puppeteer.js

如果报 “Could not find Chrome”，优先用 channel: 'chrome' 或设置 PUPPETEER_EXECUTABLE_PATH。也可安装受管 Chrome：npx puppeteer browsers install chrome
