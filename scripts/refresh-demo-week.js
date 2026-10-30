'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const weekPlan = [
  ['软件工程', 60, '整理用例与需求说明，检查课程管理流程。'],
  ['数据库系统', 75, '练习分组查询和多表连接。'],
  ['计算机网络', 45, '复习 TCP 连接过程与传输层习题。'],
  ['算法设计与分析', 90, '完成动态规划练习，整理状态转移。'],
  ['操作系统', 60, '复习进程同步，完成信号量习题。'],
  ['计算机组成原理', 50, '复习 Cache 映射方式与地址转换。'],
  ['Web 应用开发', 80, '检查表单校验，联调课程与学习记录接口。'],
];

function supplementDemoWeek(db, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '') || new Date(`${today}T00:00:00Z`).toISOString().slice(0, 10) !== today) {
    throw new Error('基准日期应为有效的 YYYY-MM-DD 日期');
  }
  const result = { added: 0, days: [] };
  db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = 'student'").get();
    if (user) {
      const courses = db.prepare('SELECT id, name FROM courses WHERE user_id = ? ORDER BY id').all(user.id);
      if (!courses.length) throw new Error('演示账号没有课程，无法补充学习记录');
      const insert = db.prepare('INSERT INTO records (user_id, course_id, study_date, duration, content, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (let index = 0; index < 7; index++) {
        const date = new Date(`${today}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 6 + index);
        const day = date.toISOString().slice(0, 10);
        // 只补没有记录的日期，已有记录与其他账号不作更改。
        const existing = db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND study_date = ?').get(user.id, day).n;
        const [name, duration, content] = weekPlan[index];
        if (!existing) {
          const course = courses.find(item => item.name === name) || courses[index % courses.length];
          insert.run(user.id, course.id, day, duration, `演示记录：${content}`, new Date().toISOString());
          result.added++;
        }
        result.days.push({ date: day, minutes: db.prepare('SELECT COALESCE(SUM(duration), 0) AS minutes FROM records WHERE user_id = ? AND study_date = ?').get(user.id, day).minutes });
      }
    }
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

if (require.main === module) {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '../data/study.db'));
  const today = process.argv[3] || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const db = new DatabaseSync(file);
  try { console.log(JSON.stringify(supplementDemoWeek(db, today))); } finally { db.close(); }
}

module.exports = { supplementDemoWeek };
