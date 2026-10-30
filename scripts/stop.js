'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const stateFile = path.join(root, 'logs', 'server.json');
const instance = createHash('sha256').update(root).digest('hex').slice(0, 12);

function health(port) {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/api/health`, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body).data); } catch { resolve(null); }
      });
    });
    request.setTimeout(1000, () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function main() {
  if (!fs.existsSync(stateFile)) {
    console.log('当前文件夹没有通过启动脚本运行的系统。');
    return;
  }
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!Number.isInteger(state.pid) || !Number.isInteger(state.port)) throw new Error('运行状态文件无效。');
  const current = await health(state.port);
  if (!current) {
    fs.unlinkSync(stateFile);
    console.log('系统已经停止。');
    return;
  }
  if (current.app !== 'study-course-manager' || current.instance !== instance || current.pid !== state.pid) {
    throw new Error('该端口上的程序与此文件夹的系统不一致，未执行停止。');
  }
  process.kill(state.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const ready = await health(state.port);
    if (!ready || ready.pid !== state.pid) {
      fs.unlinkSync(stateFile);
      console.log('系统已停止，学习数据已保存在 data 文件夹。');
      return;
    }
  }
  throw new Error('停止操作尚未完成，请稍后重试。');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
