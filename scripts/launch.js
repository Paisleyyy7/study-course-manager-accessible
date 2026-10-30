'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3000);
const url = `http://127.0.0.1:${port}/`;
const instance = createHash('sha256').update(root).digest('hex').slice(0, 12);
const logs = path.join(root, 'logs');
const stateFile = path.join(logs, 'server.json');

function health() {
  return new Promise(resolve => {
    const request = http.get(`${url}api/health`, response => {
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

async function openBrowser() {
  if (process.argv.includes('--no-browser')) return;
  if (process.platform === 'win32') {
    const command = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Start-Process -FilePath '${url}' -WindowStyle Normal`;
    const result = await new Promise(resolve => {
      let finished = false;
      let errorText = '';
      let timer;
      const finish = (ok, message = '') => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ ok, message });
      };
      const opener = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      });
      opener.stderr.setEncoding('utf8');
      opener.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
      opener.on('error', error => finish(false, error.message));
      opener.on('close', code => finish(code === 0, errorText.trim()));
      timer = setTimeout(() => {
        opener.kill();
        finish(false, '打开默认浏览器超时。');
      }, 12000);
    });
    if (result.ok) {
      console.log('已请求打开默认浏览器。');
    } else {
      console.log('自动打开浏览器未成功，系统服务仍在运行。');
      if (result.message) console.log(result.message);
      console.log(`请打开浏览器，在地址栏输入：${url}`);
    }
  } else {
    console.log(`请在浏览器打开 ${url}`);
  }
}

async function main() {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口应为 1024 至 65535 之间的整数。');
  fs.mkdirSync(logs, { recursive: true });
  const current = await health();
  if (current) {
    if (current.app !== 'study-course-manager' || current.instance !== instance) {
      throw new Error(`端口 ${port} 正在被其他程序或另一份系统占用。请先停止它，再启动此文件夹内的系统。`);
    }
    console.log(`系统已经启动：${url}`);
    await openBrowser();
    return;
  }

  const output = fs.openSync(path.join(logs, 'server.log'), 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', output, output]
  });
  fs.closeSync(output);
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();

  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnError) throw spawnError;
    await new Promise(resolve => setTimeout(resolve, 250));
    const ready = await health();
    if (ready?.app === 'study-course-manager' && ready.instance === instance && ready.pid === child.pid) {
      fs.writeFileSync(stateFile, JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString() }, null, 2));
      console.log(`系统启动成功：${url}`);
      await openBrowser();
      return;
    }
    if (ready) break;
  }
  if (child.pid) {
    try { process.kill(child.pid); } catch {}
  }
  throw new Error(`系统未能启动。请查看 logs\\server.log，确认端口 ${port} 没有被占用。`);
}

main().then(() => {
  if (process.argv.includes('--startup-window')) {
    console.log(`\n网页地址：${url}`);
    console.log('系统已在后台运行，关闭此窗口不会停止系统。');
    console.log('使用结束后，请双击“停止系统.bat”。');
    console.log('\n按任意键关闭此窗口。');
  }
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
