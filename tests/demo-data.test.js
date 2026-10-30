const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server');
const { upgradeDemoData, DEMO_DATA_VERSION } = require('../database/demo-data');

const schema = readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
const fixtureDate = '2026-10-03';
const fixtureTime = '2026-10-03T02:00:00.000Z';

async function withTemporaryDirectory(action) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'study-demo-test-'));
  try {
    await action(dataDir);
  } finally {
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^study-demo-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

function counts(db, userId) {
  return Object.fromEntries(['courses', 'records', 'reminders'].map(table => [
    table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(userId).count),
  ]));
}

function businessSnapshot(db, userId) {
  return Object.fromEntries(['courses', 'records', 'reminders'].map(table => [
    table, db.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY id`).all(userId),
  ]));
}

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
}

function oldDatabase(db) {
  db.exec(schema);
  const addUser = db.prepare(`
    INSERT INTO users (username, display_name, password_salt, password_hash, created_at)
    VALUES (?, ?, 'fixture_salt', 'fixture_hash', ?)
  `);
  const studentId = Number(addUser.run('student', '示例用户', fixtureTime).lastInsertRowid);
  const otherId = Number(addUser.run('another_student', '李同学', fixtureTime).lastInsertRowid);
  const emptyId = Number(addUser.run('empty_student', '赵同学', fixtureTime).lastInsertRowid);
  const addCourse = db.prepare(`
    INSERT INTO courses (user_id, name, category, teacher, description, target_minutes, deadline, created_at)
    VALUES (?, ?, '专业课程', '李老师', ?, ?, '2026-11-02', ?)
  `);
  const oldIds = [
    ['软件工程', '学习需求分析、系统设计和软件测试，完成小组课程项目。', 1800],
    ['数据库系统', '复习关系模型与 SQL，练习数据库设计和查询。', 1200],
    ['数据结构', '复习线性表、树、图和排序，完成算法练习。', 300],
  ].map(course => Number(addCourse.run(studentId, ...course, fixtureTime).lastInsertRowid));
  const addRecord = db.prepare(`
    INSERT INTO records (user_id, course_id, study_date, duration, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const [courseIndex, date, duration, content] of [
    [0, '2026-09-28', 60, '整理课程项目需求。'],
    [1, '2026-09-29', 90, '练习多表连接。'],
    [2, '2026-09-30', 120, '复习二叉树遍历。'],
    [0, '2026-10-01', 80, '设计登录流程。'],
    [2, '2026-10-02', 180, '练习最短路径。'],
    [1, fixtureDate, 45, '复习数据库约束。'],
  ]) addRecord.run(studentId, oldIds[courseIndex], date, duration, content, fixtureTime);
  const addReminder = db.prepare(`
    INSERT INTO reminders (user_id, course_id, title, due_at, repeat_rule, enabled, done, created_at)
    VALUES (?, ?, ?, '2026-10-04T11:00:00.000Z', ?, 1, 0, ?)
  `);
  addReminder.run(studentId, oldIds[0], '学习软件工程 30 分钟', 'daily', fixtureTime);
  addReminder.run(studentId, oldIds[1], '完成数据库查询练习', 'none', fixtureTime);
  assert.deepEqual(counts(db, studentId), { courses: 3, records: 6, reminders: 2 });

  db.prepare('UPDATE courses SET description = ? WHERE id = ?').run('我的课程备注，请保留。', oldIds[0]);
  const personalCourseId = Number(addCourse.run(studentId, '大学英语', '我自行添加的课程。', 600, fixtureTime).lastInsertRowid);
  addRecord.run(studentId, personalCourseId, fixtureDate, 35, '我的新增记录，请保留。', fixtureTime);
  const otherCourseId = Number(addCourse.run(otherId, '操作系统复习', '另一账号的课程说明。', 800, fixtureTime).lastInsertRowid);
  addRecord.run(otherId, otherCourseId, fixtureDate, 50, '另一账号的学习内容。', fixtureTime);
  addReminder.run(otherId, otherCourseId, '复习进程调度', 'weekly', fixtureTime);
  return { studentId, otherId, emptyId };
}

test('首次启动准备完整演示数据，新注册账号保持空白', { timeout: 15_000 }, async () => {
  await withTemporaryDirectory(async dataDir => {
    const app = createApp({ dataDir });
    let db;
    try {
      await new Promise((resolve, reject) => {
        app.server.once('error', reject);
        app.server.listen(0, '127.0.0.1', resolve);
      });
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'demo_new_student', password: 'Test12345', displayName: '新同学' }),
      });
      assert.ok(response.ok);
      const user = (await response.json()).data;
      db = new DatabaseSync(path.join(dataDir, 'study.db'));
      const student = db.prepare('SELECT id FROM users WHERE username = ?').get('student');
      assert.deepEqual(counts(db, student.id), { courses: 12, records: 60, reminders: 10 });
      assert.deepEqual(counts(db, user.id), { courses: 0, records: 0, reminders: 0 });
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, DEMO_DATA_VERSION);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const actualToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      const records = db.prepare('SELECT study_date, duration FROM records WHERE user_id = ?').all(student.id);
      assert.ok(records.every(record => record.study_date <= actualToday));
      assert.ok(records.every(record => Number.isInteger(record.duration) && record.duration >= 1 && record.duration <= 1440));
      const progress = db.prepare(`
        SELECT c.target_minutes, COALESCE(SUM(r.duration), 0) AS minutes
        FROM courses c LEFT JOIN records r ON r.course_id = c.id
        WHERE c.user_id = ? GROUP BY c.id
      `).all(student.id);
      assert.ok(progress.some(course => course.minutes === 0));
      assert.ok(progress.some(course => course.minutes > 0 && course.minutes < course.target_minutes));
      assert.ok(progress.some(course => course.minutes >= course.target_minutes));
      const repeatRules = new Set(db.prepare('SELECT repeat_rule FROM reminders WHERE user_id = ?').all(student.id)
        .map(reminder => reminder.repeat_rule));
      for (const rule of ['none', 'daily', 'weekly']) assert.ok(repeatRules.has(rule));
    } finally {
      if (db) db.close();
      await app.close();
    }
  });
});

test('旧演示数据增量升级保留用户内容，重复启动不补回已删除数据', async () => {
  await withTemporaryDirectory(async dataDir => {
    const databasePath = path.join(dataDir, 'study.db');
    let db = new DatabaseSync(databasePath);
    try {
      const { studentId, otherId, emptyId } = oldDatabase(db);
      const original = businessSnapshot(db, studentId);
      const otherOriginal = businessSnapshot(db, otherId);
      const originalTables = tables(db);
      const result = upgradeDemoData(db, { today: fixtureDate });
      assert.equal(result.upgraded, true);
      const upgraded = businessSnapshot(db, studentId);
      const totals = counts(db, studentId);
      assert.ok(totals.courses >= 12 && totals.records >= 60 && totals.reminders >= 10);
      for (const table of ['courses', 'records', 'reminders']) {
        const originalIds = new Set(original[table].map(row => row.id));
        assert.deepEqual(upgraded[table].filter(row => originalIds.has(row.id)), original[table]);
      }
      assert.deepEqual(businessSnapshot(db, otherId), otherOriginal);
      assert.deepEqual(counts(db, emptyId), { courses: 0, records: 0, reminders: 0 });
      assert.deepEqual(tables(db), originalTables);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, DEMO_DATA_VERSION);

      assert.equal(upgradeDemoData(db, { today: '2026-10-04' }).upgraded, false);
      assert.deepEqual(businessSnapshot(db, studentId), upgraded);
      const originalCourseIds = new Set(original.courses.map(row => row.id));
      const addedCourse = upgraded.courses.find(row => !originalCourseIds.has(row.id));
      assert.ok(addedCourse);
      db.prepare('DELETE FROM courses WHERE id = ?').run(addedCourse.id);
      const afterDeletion = businessSnapshot(db, studentId);
      assert.ok(afterDeletion.courses.length < upgraded.courses.length);
      db.close();
      db = new DatabaseSync(databasePath);
      db.exec('PRAGMA foreign_keys = ON');
      assert.equal(upgradeDemoData(db, { today: '2026-10-05' }).upgraded, false);
      assert.deepEqual(businessSnapshot(db, studentId), afterDeletion);
      assert.deepEqual(businessSnapshot(db, otherId), otherOriginal);
    } finally {
      db.close();
    }
  });
});
