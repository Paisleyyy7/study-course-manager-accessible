const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { supplementDemoWeek } = require('../scripts/refresh-demo-week');

test('演示账号补齐七天，保留已有记录和其他账号，重复运行不会重复添加', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8'));
    const addUser = db.prepare("INSERT INTO users (username, display_name, password_salt, password_hash, created_at) VALUES (?, '同学', 'salt', 'hash', '2026-10-01')");
    const student = Number(addUser.run('student').lastInsertRowid);
    const other = Number(addUser.run('other').lastInsertRowid);
    const course = Number(db.prepare("INSERT INTO courses (user_id, name, target_minutes, created_at) VALUES (?, '软件工程', 1800, '2026-10-01')").run(student).lastInsertRowid);
    const otherCourse = Number(db.prepare("INSERT INTO courses (user_id, name, target_minutes, created_at) VALUES (?, '数据库', 1800, '2026-10-01')").run(other).lastInsertRowid);
    const insert = db.prepare("INSERT INTO records (user_id, course_id, study_date, duration, content, created_at) VALUES (?, ?, ?, 35, '原有记录', '2026-10-01')");
    insert.run(student, course, '2026-10-10'); insert.run(other, otherCourse, '2026-10-09');
    const originals = db.prepare('SELECT * FROM records ORDER BY id').all();
    const result = supplementDemoWeek(db, '2026-10-14');
    assert.equal(result.added, 6);
    assert.equal(result.days.length, 7);
    assert.ok(result.days.every(day => day.minutes > 0));
    assert.equal(result.days[2].minutes, 35);
    assert.deepEqual(db.prepare('SELECT * FROM records WHERE id <= 2 ORDER BY id').all(), originals);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ?').get(other).n, 1);
    assert.ok(db.prepare('SELECT content FROM records WHERE id > 2').all().every(row => row.content.startsWith('演示记录：')));
    assert.equal(supplementDemoWeek(db, '2026-10-14').added, 0);
    assert.throws(() => supplementDemoWeek(db, '2026-02-30'));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
