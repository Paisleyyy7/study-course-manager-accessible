const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const port = 3102;
const base = `http://127.0.0.1:${port}/api`;

function client() {
  let cookie = '';
  return async (route, method = 'GET', body) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.getSetCookie();
    for (const item of setCookie) {
      const pair = item.split(';', 1)[0];
      cookie = pair.endsWith('=') ? '' : pair;
    }
    const payload = await response.json();
    return { status: response.status, data: payload.data, error: payload.error };
  };
}

function success(result, message) {
  assert.ok(result.status >= 200 && result.status < 300,
    `${message || '请求应成功'}：${result.status} ${result.error || ''}`);
  return result.data;
}

function rejected(result, statuses = [400, 401, 403, 404, 409]) {
  assert.ok(statuses.includes(result.status), `请求应被拒绝，实际状态为 ${result.status}`);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
}

async function launch(dataDir) {
  const processHandle = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  processHandle.stdout.on('data', data => { output += data; });
  processHandle.stderr.on('data', data => { output += data; });
  let launchError;
  processHandle.on('error', error => { launchError = error; });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (processHandle.exitCode !== null) throw new Error(`服务提前退出：${output}`);
    try {
      const response = await fetch(base + '/health');
      const payload = await response.json();
      if (response.ok && (payload.data?.app || payload.app) === 'study-course-manager') return processHandle;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  processHandle.kill();
  throw new Error(`服务启动超时：${output}`);
}

async function stop(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  await new Promise(resolve => {
    processHandle.once('exit', resolve);
    processHandle.kill();
  });
}

test('学习计划的增删改查、任务打卡与账号隔离', { timeout: 60_000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'study-plans-test-'));
  let server;
  let first = client();
  const second = client();
  let planId;
  let taskId;

  try {
    server = await launch(dataDir);
    success(await first('/auth/register', 'POST', { username: 'plan_tester', password: 'Test12345', displayName: '计划同学' }));
    success(await second('/auth/register', 'POST', { username: 'plan_other', password: 'Test12345' }));

    await t.test('创建计划与字段校验', async () => {
      const plan = success(await first('/plans', 'POST', {
        level: 'weekly', title: '数据结构第一周', category: '专业课程', goal: '复习线性表',
        startDate: '2026-10-19', endDate: '2026-10-25', aiPlanning: '一、目标\n二、任务', status: '进行中',
      }));
      planId = plan.id;
      assert.equal(plan.level, 'weekly');
      assert.equal(plan.title, '数据结构第一周');
      assert.equal(plan.category, '专业课程');
      assert.equal(plan.taskCount, 0);
      rejected(await first('/plans', 'POST', { level: 'bad', title: 'x' }), [400]);
      rejected(await first('/plans', 'POST', { level: 'weekly', title: '' }), [400]);
      rejected(await first('/plans', 'POST', { level: 'weekly', title: 'x', status: '未知' }), [400]);
      assert.equal(success(await second('/plans')).length, 0);
    });

    await t.test('获取计划列表与详情', async () => {
      const list = success(await first('/plans'));
      assert.equal(list.length, 1);
      assert.equal(list[0].id, planId);
      const detail = success(await first(`/plans/${planId}`));
      assert.equal(detail.id, planId);
      assert.ok(Array.isArray(detail.tasks));
      assert.equal(detail.tasks.length, 0);
      rejected(await second(`/plans/${planId}`), [403, 404]);
    });

    await t.test('添加、编辑任务与账号隔离', async () => {
      const task = success(await first(`/plans/${planId}/tasks`, 'POST', {
        subject: '数据结构', goal: '复习二叉树', dueDate: '2026-10-20', completed: false, note: '',
      }));
      taskId = task.id;
      assert.equal(task.subject, '数据结构');
      assert.equal(task.completed, false);
      rejected(await second(`/plans/${planId}/tasks`, 'POST', { subject: '别人的任务', completed: false }), [403, 404]);
      rejected(await first(`/plans/${planId}/tasks`, 'POST', { subject: '', completed: false }), [400]);
      const edited = success(await first(`/plans/${planId}/tasks/${taskId}`, 'PUT', {
        subject: '数据结构', goal: '复习二叉树并刷题', dueDate: '2026-10-20', completed: true, note: '完成 10 题',
      }));
      assert.equal(edited.goal, '复习二叉树并刷题');
      assert.equal(edited.completed, true);
      const detail = success(await first(`/plans/${planId}`));
      assert.equal(detail.taskCount, 1);
      assert.equal(detail.completedCount, 1);
    });

    await t.test('多次计划按层级筛选数据完整性', async () => {
      success(await first('/plans', 'POST', { level: 'midterm', title: '期中复习', category: '专业课程', status: '进行中' }));
      success(await first('/plans', 'POST', { level: 'longterm', title: '本学期项目', category: '专业课程', status: '进行中' }));
      const all = success(await first('/plans'));
      assert.equal(all.length, 3);
      assert.ok(all.some(plan => plan.level === 'weekly'));
      assert.ok(all.some(plan => plan.level === 'midterm'));
      assert.ok(all.some(plan => plan.level === 'longterm'));
    });

    await t.test('删除计划级联删除任务，重启后持久化', async () => {
      await stop(server);
      server = await launch(dataDir);
      first = client();
      success(await first('/auth/login', 'POST', { username: 'plan_tester', password: 'Test12345' }));
      assert.ok(success(await first('/plans')).some(plan => plan.id === planId));
      success(await first(`/plans/${planId}`, 'DELETE'));
      assert.equal(success(await first('/plans')).length, 2);
      // 任务随计划级联删除
      rejected(await first(`/plans/${planId}/tasks`), [404]);
    });
  } finally {
    await stop(server);
    const resolvedDataDir = path.resolve(dataDir);
    assert.equal(path.dirname(resolvedDataDir), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolvedDataDir), /^study-plans-test-/);
    await fs.rm(resolvedDataDir, { recursive: true, force: true });
  }
});
