const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const port = 3101;
const base = `http://127.0.0.1:${port}/api`;

function today() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

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
      if (response.ok && (payload.data?.app || payload.app) === 'study-course-manager') {
        return processHandle;
      }
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

test('课程、学习记录和提醒的完整使用流程', { timeout: 60_000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'study-course-test-'));
  let server;
  let first = client();
  const second = client();
  let courseId;
  let recordId;
  let oneTimeId;
  let repeatingId;
  const username = 'course_tester';
  const password = 'Test12345';

  try {
    server = await launch(dataDir);

    await t.test('登录注册、重名拒绝和安全退出', async () => {
      rejected(await first('/courses'), [401]);
      success(await first('/auth/register', 'POST', { username, password, displayName: '测试同学' }));
      rejected(await second('/auth/register', 'POST', { username, password }), [400, 409]);
      success(await first('/auth/logout', 'POST'));
      rejected(await first('/auth/me'), [401]);
      rejected(await first('/auth/login', 'POST', { username, password: 'Wrong123' }), [401]);
      success(await first('/auth/login', 'POST', { username, password }));
      assert.equal(success(await first('/auth/me')).username, username);
      success(await second('/auth/register', 'POST', {
        username: 'other_tester', password, displayName: '另一位同学',
      }));
      success(await second('/auth/login', 'POST', { username: 'other_tester', password }));
    });

    await t.test('课程新增、编辑、内容存储与账号隔离', async () => {
      const course = success(await first('/courses', 'POST', {
        name: '数据结构', category: '专业课', teacher: '王老师',
        description: '<script>alert("课程")</script>', targetMinutes: 120, deadline: '',
      }));
      courseId = course.id;
      assert.ok(courseId);
      assert.equal(course.description, '<script>alert("课程")</script>');
      assert.equal(Number(course.completedMinutes), 0);
      assert.equal(Number(course.progress), 0);
      const edited = success(await first(`/courses/${courseId}`, 'PUT', {
        name: '数据结构与算法', category: '专业课', teacher: '王老师',
        description: '线性表、树和图', targetMinutes: 120, deadline: '',
      }));
      assert.equal(edited.name, '数据结构与算法');
      assert.ok(success(await first('/courses')).some(item => item.id === courseId));
      assert.equal(success(await second('/courses')).length, 0);
      rejected(await second(`/courses/${courseId}`, 'PUT', { name: '修改别人的课程', targetMinutes: 30 }), [403, 404]);
      rejected(await second(`/courses/${courseId}`, 'DELETE'), [403, 404]);
      rejected(await first('/courses', 'POST', { name: '', targetMinutes: 120 }), [400]);
    });

    await t.test('记录自动更新进度和统计，拒绝未来学习日期', async () => {
      const date = today();
      const record = success(await first('/records', 'POST', {
        courseId, date, duration: 45, content: '学习顺序表与链表，完成课后练习。',
      }));
      recordId = record.id;
      const course = success(await first('/courses')).find(item => item.id === courseId);
      assert.equal(Number(course.completedMinutes), 45);
      assert.equal(Number(course.progress), 37.5);
      const stats = success(await first('/stats'));
      assert.equal(Number(stats.courseCount), 1);
      assert.equal(Number(stats.totalMinutes), 45);
      assert.equal(Number(stats.todayMinutes), 45);
      assert.equal(Number(stats.weekMinutes), 45);
      assert.equal(stats.weekly.length, 7);
      assert.equal(Number(stats.weekly.find(item => item.date === date).minutes), 45);
      assert.equal(Number(stats.byCourse.find(item => item.courseId === courseId).minutes), 45);
      success(await first(`/records/${recordId}`, 'PUT', {
        courseId, date, duration: 60, content: '补充学习时间。',
      }));
      assert.equal(Number(success(await first('/courses')).find(item => item.id === courseId).progress), 50);
      assert.equal(Number(success(await first('/stats')).totalMinutes), 60);
      success(await first(`/records/${recordId}`, 'PUT', {
        courseId, date, duration: 45, content: '学习顺序表与链表，完成课后练习。',
      }));
      assert.equal(Number(success(await first('/stats')).totalMinutes), 45);
      assert.equal(success(await second('/records')).length, 0);
      rejected(await second('/records', 'POST', { courseId, date, duration: 10, content: '' }), [403, 404]);
      rejected(await second(`/records/${recordId}`, 'DELETE'), [403, 404]);
      rejected(await first('/records', 'POST', {
        courseId, date: '2099-01-01', duration: 30, content: '未来记录',
      }), [400]);
      rejected(await first('/records', 'POST', { courseId, date, duration: 0, content: '' }), [400]);
      const secondRecord = success(await first('/records', 'POST', {
        courseId, date, duration: 90, content: '复习树与图。',
      }));
      const completed = success(await first('/courses')).find(item => item.id === courseId);
      assert.equal(Number(completed.completedMinutes), 135);
      assert.equal(Number(completed.progress), 100);
      assert.equal(Number(success(await first('/stats')).completedCourses), 1);
      success(await first(`/records/${secondRecord.id}`, 'DELETE'));
      assert.equal(Number(success(await first('/stats')).totalMinutes), 45);
    });

    await t.test('接近学习目标时仍显示未完成，达到目标后完成', async () => {
      const date = today();
      success(await first(`/records/${recordId}`, 'PUT', {
        courseId, date, duration: 119, content: '继续完成课程学习目标。',
      }));
      const nearTarget = success(await first('/courses')).find(item => item.id === courseId);
      assert.ok(Number(nearTarget.progress) >= 99 && Number(nearTarget.progress) < 100);
      assert.equal(Number(success(await first('/stats')).completedCourses), 0);
      success(await first(`/records/${recordId}`, 'PUT', {
        courseId, date, duration: 120, content: '完成课程学习目标。',
      }));
      assert.equal(Number(success(await first('/courses')).find(item => item.id === courseId).progress), 100);
      assert.equal(Number(success(await first('/stats')).completedCourses), 1);
      success(await first(`/records/${recordId}`, 'PUT', {
        courseId, date, duration: 45, content: '学习顺序表与链表，完成课后练习。',
      }));
    });

    await t.test('单次提醒完成、重复提醒推进与账号隔离', async () => {
      const dueAt = new Date(Date.now() - 60_000).toISOString();
      const oneTime = success(await first('/reminders', 'POST', {
        courseId, title: '复习链表', dueAt, repeat: 'none', enabled: true,
      }));
      oneTimeId = oneTime.id;
      const repeating = success(await first('/reminders', 'POST', {
        courseId, title: '每日复习', dueAt, repeat: 'daily', enabled: true,
      }));
      repeatingId = repeating.id;
      assert.equal(success(await second('/reminders')).length, 0);
      rejected(await second(`/reminders/${oneTimeId}/complete`, 'POST'), [403, 404]);
      rejected(await second('/reminders', 'POST', {
        courseId, title: '别人的课程提醒', dueAt, repeat: 'none', enabled: true,
      }), [403, 404]);
      success(await first(`/reminders/${oneTimeId}/complete`, 'POST'));
      const done = success(await first('/reminders')).find(item => item.id === oneTimeId);
      assert.equal(Boolean(done.done), true);
      success(await first(`/reminders/${repeatingId}/complete`, 'POST'));
      const next = success(await first('/reminders')).find(item => item.id === repeatingId);
      assert.ok(Date.parse(next.dueAt) > Date.now());
      assert.ok(Date.parse(next.dueAt) > Date.parse(dueAt));
      assert.equal(Boolean(next.done), false);
      assert.equal(Boolean(next.enabled), true);
      const weekly = success(await first('/reminders', 'POST', {
        courseId, title: '每周总结', dueAt, repeat: 'weekly', enabled: true,
      }));
      success(await first(`/reminders/${weekly.id}/complete`, 'POST'));
      const nextWeek = success(await first('/reminders')).find(item => item.id === weekly.id);
      assert.equal(Date.parse(nextWeek.dueAt) - Date.parse(dueAt), 7 * 24 * 60 * 60 * 1000);
      assert.equal(Boolean(nextWeek.done), false);
      const disabled = success(await first(`/reminders/${repeatingId}`, 'PUT', {
        courseId, title: '每日复习', dueAt: next.dueAt, repeat: 'daily', enabled: false,
      }));
      assert.equal(Boolean(disabled.enabled), false);
    });

    let readOnceId;
    await t.test('单条和批量已读持久化，重复提醒推进且旧页面不会跳过下一次', async () => {
      const dueAt = new Date(Date.now() - 60_000).toISOString();
      const make = async repeat => success(await first('/reminders', 'POST', {
        courseId, title: `已读测试 ${repeat}`, dueAt, repeat, enabled: true,
      }));
      const once = await make('none');
      readOnceId = once.id;
      const daily = await make('daily');
      const weekly = await make('weekly');
      const items = [once, daily, weekly].map(item => ({ id: item.id, dueAt: item.dueAt }));
      rejected(await second('/reminders/read', 'POST', { items }), [404]);
      rejected(await first('/reminders/read', 'POST', { items: [] }), [400]);
      rejected(await first('/reminders/read', 'POST', { items: [{ id: 'bad', dueAt }] }), [400]);
      success(await first('/reminders/read', 'POST', { items: [items[0]] }));
      const acknowledged = success(await first('/reminders')).find(item => item.id === once.id);
      assert.equal(acknowledged.readDueAt, dueAt);
      assert.equal(acknowledged.done, false);
      success(await first('/reminders/read', 'POST', { items }));
      const after = success(await first('/reminders'));
      for (const [item, interval] of [[daily, 86400000], [weekly, 7 * 86400000]]) {
        const next = after.find(row => row.id === item.id);
        assert.equal(Date.parse(next.dueAt) - Date.parse(dueAt), interval);
        assert.equal(next.done, false);
      }
      success(await first('/reminders/read', 'POST', { items }));
      assert.equal(success(await first('/reminders')).find(item => item.id === daily.id).dueAt,
        after.find(item => item.id === daily.id).dueAt);
      const future = success(await first('/reminders', 'POST', {
        title: '尚未到期', dueAt: new Date(Date.now() + 3600000).toISOString(), repeat: 'none', enabled: true,
      }));
      success(await first('/reminders/read', 'POST', { items: [{ id: future.id, dueAt: future.dueAt }] }));
      assert.equal(success(await first('/reminders')).find(item => item.id === future.id).readDueAt, null);
      success(await first(`/reminders/${future.id}`, 'DELETE'));
      assert.equal(Number(success(await first('/stats')).totalMinutes), 45);
    });

    await t.test('服务重启后数据保存，删除课程级联清理', async () => {
      await stop(server);
      server = await launch(dataDir);
      first = client();
      success(await first('/auth/login', 'POST', { username, password }));
      assert.ok(success(await first('/courses')).some(item => item.id === courseId));
      assert.ok(success(await first('/records')).some(item => item.id === recordId));
      assert.equal(Boolean(success(await first('/reminders')).find(item => item.id === oneTimeId).done), true);
      const read = success(await first('/reminders')).find(item => item.id === readOnceId);
      assert.equal(read.readDueAt, read.dueAt);
      success(await first(`/courses/${courseId}`, 'DELETE'));
      assert.equal(success(await first('/courses')).length, 0);
      assert.equal(success(await first('/records')).length, 0);
      assert.equal(success(await first('/reminders')).length, 0);
      assert.equal(Number(success(await first('/stats')).totalMinutes), 0);
      success(await first('/auth/logout', 'POST'));
      rejected(await first('/stats'), [401]);
    });
  } finally {
    await stop(server);
    const resolvedDataDir = path.resolve(dataDir);
    assert.equal(path.dirname(resolvedDataDir), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolvedDataDir), /^study-course-test-/);
    await fs.rm(resolvedDataDir, { recursive: true, force: true });
  }
});
