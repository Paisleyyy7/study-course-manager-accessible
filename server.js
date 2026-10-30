'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { upgradeDemoData } = require('./database/demo-data');

const scrypt = promisify(crypto.scrypt);
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const AI_CONFIG_FILE = path.join(__dirname, 'data', 'ai-config.json');
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
const INSTANCE_ID = crypto.createHash('sha256').update(path.resolve(__dirname)).digest('hex').slice(0, 12);
const DAY_MS = 24 * 60 * 60 * 1000;
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function today() {
    return dateFormatter.format(new Date());
}

function getAiConfig() {
    const defaults = {
        apiKey: '',
        apiUrl: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-flash'
    };
    try {
        const config = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'));
        return { ...defaults, ...config };
    } catch (_) {
        return defaults;
    }
}

function shiftDate(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const valueDate = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(valueDate.getTime()) && valueDate.toISOString().slice(0, 10) === value;
}

function textField(value, label, maxLength, required = false) {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') throw new HttpError(400, `${label}格式不正确`);
    value = value.trim();
    if (required && !value) throw new HttpError(400, `请填写${label}`);
    if (value.length > maxLength) throw new HttpError(400, `${label}最多填写${maxLength}个字符`);
    return value;
}

function integerField(value, label, min, max) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
        throw new HttpError(400, `${label}必须是${min}到${max}之间的整数`);
    }
    return value;
}

function resourceId(value) {
    if (!/^\d+$/.test(value)) throw new HttpError(404, '未找到该项数据');
    return integerField(Number(value), '编号', 1, Number.MAX_SAFE_INTEGER);
}

function progressFor(minutes, target) {
    return Math.min(100, Math.floor(minutes / target * 1000) / 10);
}

function publicUser(row) {
    return { id: row.id, username: row.username, displayName: row.display_name };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(header = '') {
    const cookies = {};
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        try {
            cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
        } catch (_) {
            // 忽略损坏的 Cookie。
        }
    }
    return cookies;
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
            req.resume();
            reject(new HttpError(413, '提交内容过大'));
            return;
        }
        let bytes = 0;
        let exceeded = false;
        const chunks = [];
        req.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) {
                if (!exceeded) reject(new HttpError(413, '提交内容过大'));
                exceeded = true;
                chunks.length = 0;
                return;
            }
            if (!exceeded) chunks.push(chunk);
        });
        req.on('end', () => {
            if (exceeded) return;
            if (bytes && !(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
                reject(new HttpError(415, '请使用 JSON 格式提交数据'));
                return;
            }
            try {
                const value = bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    throw new Error('invalid body');
                }
                resolve(value);
            } catch (_) {
                reject(new HttpError(400, '提交的数据格式不正确'));
            }
        });
        req.on('aborted', () => reject(new HttpError(400, '请求已中断')));
        req.on('error', () => reject(new HttpError(400, '读取请求失败')));
    });
}

function sendJson(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function createApp(options = {}) {
    const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
    fs.mkdirSync(dataDir, { recursive: true });
    const databasePath = path.join(dataDir, 'study.db');
    const newDatabase = !fs.existsSync(databasePath);
    const db = new DatabaseSync(databasePath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    db.exec(fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8'));

    function transaction(action) {
        db.exec('BEGIN IMMEDIATE');
        try {
            const result = action();
            db.exec('COMMIT');
            return result;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    if (newDatabase) {
        transaction(() => {
            const salt = crypto.randomBytes(16).toString('hex');
            const passwordHash = crypto.scryptSync('Student123', salt, 64).toString('hex');
            const now = new Date().toISOString();
            const userId = Number(db.prepare(`
                INSERT INTO users (username, display_name, password_salt, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?)
            `).run('student', '示例用户', salt, passwordHash, now).lastInsertRowid);
            const insertCourse = db.prepare(`
                INSERT INTO courses (user_id, name, category, teacher, description, target_minutes, deadline, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const courseIds = [
                ['软件工程', '专业课程', '李老师', '学习需求分析、系统设计和软件测试，完成小组课程项目。', 1800, shiftDate(today(), 30)],
                ['数据库系统', '专业课程', '王老师', '复习关系模型与 SQL，练习数据库设计和查询。', 1200, shiftDate(today(), 21)],
                ['数据结构', '专业课程', '陈老师', '复习线性表、树、图和排序，完成算法练习。', 300, shiftDate(today(), 14)]
            ].map(course => Number(insertCourse.run(userId, ...course, now).lastInsertRowid));
            const insertRecord = db.prepare(`
                INSERT INTO records (user_id, course_id, study_date, duration, content, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            const sampleRecords = [
                [courseIds[0], -5, 60, '整理课程项目需求，确认课程管理和学习记录功能。'],
                [courseIds[1], -4, 90, '练习多表连接查询和分组统计。'],
                [courseIds[2], -3, 120, '复习二叉树遍历，完成相关练习。'],
                [courseIds[0], -2, 80, '绘制系统功能结构，设计用户登录流程。'],
                [courseIds[2], -1, 180, '完成图的遍历和最短路径练习。'],
                [courseIds[1], 0, 45, '复习主键、外键与数据库约束。']
            ];
            for (const [courseId, days, duration, content] of sampleRecords) {
                insertRecord.run(userId, courseId, shiftDate(today(), days), duration, content, now);
            }
            const insertReminder = db.prepare(`
                INSERT INTO reminders (user_id, course_id, title, due_at, repeat_rule, enabled, done, created_at)
                VALUES (?, ?, ?, ?, ?, 1, 0, ?)
            `);
            insertReminder.run(userId, courseIds[0], '学习软件工程 30 分钟',
                new Date(`${shiftDate(today(), 1)}T19:00:00+08:00`).toISOString(), 'daily', now);
            insertReminder.run(userId, courseIds[1], '完成数据库查询练习',
                new Date(`${shiftDate(today(), 2)}T18:30:00+08:00`).toISOString(), 'none', now);
        });
    }

    if (!db.prepare('PRAGMA table_info(reminders)').all().some(column => column.name === 'read_due_at')) {
        db.exec('ALTER TABLE reminders ADD COLUMN read_due_at TEXT');
    }
    upgradeDemoData(db);

    // 将数据库中的字段转换为页面使用的格式。
    function getCourses(userId, id) {
        const rows = db.prepare(`
            SELECT c.*, COALESCE(SUM(r.duration), 0) AS completed_minutes
            FROM courses c LEFT JOIN records r ON r.course_id = c.id AND r.user_id = c.user_id
            WHERE c.user_id = ? ${id === undefined ? '' : 'AND c.id = ?'}
            GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC
        `).all(...(id === undefined ? [userId] : [userId, id]));
        return rows.map(row => ({
            id: row.id,
            name: row.name,
            category: row.category,
            teacher: row.teacher,
            description: row.description,
            targetMinutes: row.target_minutes,
            deadline: row.deadline,
            completedMinutes: row.completed_minutes,
            progress: progressFor(row.completed_minutes, row.target_minutes),
            status: row.completed_minutes === 0 ? '未开始' : row.completed_minutes >= row.target_minutes ? '已完成' : '学习中'
        }));
    }

    function getRecords(userId, id) {
        return db.prepare(`
            SELECT r.id, r.course_id AS courseId, c.name AS courseName,
                   r.study_date AS date, r.duration, r.content, r.created_at AS createdAt
            FROM records r JOIN courses c ON c.id = r.course_id
            WHERE r.user_id = ? ${id === undefined ? '' : 'AND r.id = ?'}
            ORDER BY r.study_date DESC, r.created_at DESC, r.id DESC
        `).all(...(id === undefined ? [userId] : [userId, id]));
    }

    function getReminders(userId, id) {
        return db.prepare(`
            SELECT r.id, r.course_id AS courseId, c.name AS courseName, r.title,
                   r.due_at AS dueAt, r.repeat_rule AS repeat, r.enabled, r.done,
                   r.read_due_at AS readDueAt
            FROM reminders r LEFT JOIN courses c ON c.id = r.course_id
            WHERE r.user_id = ? ${id === undefined ? '' : 'AND r.id = ?'}
            ORDER BY r.done ASC, r.enabled DESC, r.due_at ASC, r.id ASC
        `).all(...(id === undefined ? [userId] : [userId, id]))
            .map(row => ({ ...row, enabled: Boolean(row.enabled), done: Boolean(row.done) }));
    }

    function requireCourse(userId, courseId) {
        if (!db.prepare('SELECT id FROM courses WHERE id = ? AND user_id = ?').get(courseId, userId)) {
            throw new HttpError(404, '课程不存在，请重新选择');
        }
    }

    function getPlans(userId, id) {
        const rows = db.prepare(`
            SELECT p.id, p.level, p.title, p.category, p.goal, p.start_date AS startDate,
                   p.end_date AS endDate, p.ai_planning AS aiPlanning, p.status, p.created_at AS createdAt,
                   (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.id AND t.user_id = p.user_id) AS taskCount,
                   (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.id AND t.user_id = p.user_id AND t.completed = 1) AS completedCount
            FROM study_plans p
            WHERE p.user_id = ? ${id === undefined ? '' : 'AND p.id = ?'}
            ORDER BY p.created_at DESC, p.id DESC
        `).all(...(id === undefined ? [userId] : [userId, id]));
        return rows.map(row => ({
            id: row.id,
            level: row.level,
            title: row.title,
            category: row.category,
            goal: row.goal,
            startDate: row.startDate,
            endDate: row.endDate,
            aiPlanning: row.aiPlanning,
            status: row.status,
            createdAt: row.createdAt,
            taskCount: row.taskCount,
            completedCount: row.completedCount
        }));
    }

    function getPlanTasks(userId, planId) {
        return db.prepare(`
            SELECT t.id, t.plan_id AS planId, t.subject, t.goal, t.due_date AS dueDate,
                   t.completed, t.proof_image AS proofImage, t.note, t.sort_order AS sortOrder
            FROM plan_tasks t
            WHERE t.user_id = ? AND t.plan_id = ?
            ORDER BY t.due_date ASC, t.sort_order ASC, t.id ASC
        `).all(userId, planId)
            .map(row => ({ ...row, completed: Boolean(row.completed) }));
    }

    function getPlanDetail(userId, planId) {
        const plan = getPlans(userId, planId)[0];
        if (!plan) throw new HttpError(404, '计划不存在，请重新选择');
        return { ...plan, tasks: getPlanTasks(userId, planId) };
    }

    function sortOrderFor(userId, planId) {
        const row = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max FROM plan_tasks WHERE user_id = ? AND plan_id = ?').get(userId, planId);
        return (row.max || 0) + 1;
    }

    function getPlanTasksReturn(userId, taskId) {
        const row = db.prepare(`
            SELECT t.id, t.plan_id AS planId, t.subject, t.goal, t.due_date AS dueDate,
                   t.completed, t.proof_image AS proofImage, t.note, t.sort_order AS sortOrder
            FROM plan_tasks t WHERE t.user_id = ? AND t.id = ?
        `).get(userId, taskId);
        if (!row) throw new HttpError(404, '任务不存在，请重新选择');
        return { ...row, completed: Boolean(row.completed) };
    }

    function requirePlan(userId, planId) {
        const plan = getPlans(userId, planId)[0];
        if (!plan) throw new HttpError(404, '计划不存在，请重新选择');
        return plan;
    }

    function planInput(body) {
        const level = body.level;
        if (!['weekly', 'midterm', 'longterm'].includes(level)) throw new HttpError(400, '计划层级不正确');
        const title = textField(body.title, '计划名称', 120, true);
        const category = textField(body.category, '计划分类', 30) || '其他';
        const goal = textField(body.goal, '目标', 1000);
        const startDate = textField(body.startDate, '开始日期', 10) || null;
        if (startDate && !validDate(startDate)) throw new HttpError(400, '开始日期不正确');
        const endDate = textField(body.endDate, '结束日期', 10) || null;
        if (endDate && !validDate(endDate)) throw new HttpError(400, '结束日期不正确');
        const aiPlanning = textField(body.aiPlanning, 'AI 规划内容', 10000);
        const status = body.status === undefined ? '进行中' : body.status;
        if (!['进行中', '已完成', '已暂停'].includes(status)) throw new HttpError(400, '计划状态不正确');
        return { level, title, category, goal, startDate, endDate, aiPlanning, status };
    }

    function planTaskInput(body) {
        const subject = textField(body.subject, '科目', 80, true);
        const goal = textField(body.goal, '任务目标', 1000);
        let dueDate = textField(body.dueDate, '打卡日期', 10) || null;
        if (dueDate && !validDate(dueDate)) throw new HttpError(400, '打卡日期不正确');
        const completed = body.completed === undefined ? false : body.completed;
        if (typeof completed !== 'boolean') throw new HttpError(400, '完成状态不正确');
        const note = textField(body.note, '备注', 1000);
        const proofImage = textField(body.proofImage, '图片凭证', 255) || null;
        return { subject, goal, dueDate, completed, note, proofImage };
    }

    function courseInput(body) {
        const name = textField(body.name, '课程名称', 80, true);
        const category = textField(body.category, '课程分类', 30) || '其他';
        const teacher = textField(body.teacher, '授课教师', 40);
        const description = textField(body.description, '课程说明', 1000);
        const targetMinutes = integerField(body.targetMinutes, '目标学习时长', 1, 100000);
        const deadline = textField(body.deadline, '计划完成日期', 10) || null;
        if (deadline && !validDate(deadline)) throw new HttpError(400, '计划完成日期不正确');
        return [name, category, teacher, description, targetMinutes, deadline];
    }

    function recordInput(body, userId) {
        const courseId = integerField(body.courseId, '课程编号', 1, Number.MAX_SAFE_INTEGER);
        requireCourse(userId, courseId);
        if (!validDate(body.date)) throw new HttpError(400, '学习日期不正确');
        if (body.date > today()) throw new HttpError(400, '学习日期不能晚于今天');
        const duration = integerField(body.duration, '学习时长', 1, 1440);
        const content = textField(body.content, '学习内容', 1000);
        return [courseId, body.date, duration, content];
    }

    function reminderInput(body, userId) {
        let courseId = body.courseId;
        if (courseId === undefined || courseId === null) courseId = null;
        else {
            courseId = integerField(courseId, '课程编号', 1, Number.MAX_SAFE_INTEGER);
            requireCourse(userId, courseId);
        }
        const title = textField(body.title, '提醒内容', 100, true);
        let dueAt = textField(body.dueAt, '提醒时间', 40, true);
        if (!validDate(dueAt.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(dueAt)) {
            throw new HttpError(400, '提醒时间不正确');
        }
        // 页面时间选择器不带时区，按北京时间保存。
        if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(dueAt)) dueAt += '+08:00';
        const parsedTime = new Date(dueAt);
        if (!Number.isFinite(parsedTime.getTime())) throw new HttpError(400, '提醒时间不正确');
        const repeat = body.repeat === undefined ? 'none' : body.repeat;
        if (!['none', 'daily', 'weekly'].includes(repeat)) throw new HttpError(400, '请选择有效的重复方式');
        const enabled = body.enabled === undefined ? true : body.enabled;
        if (typeof enabled !== 'boolean') throw new HttpError(400, '提醒启用状态不正确');
        return [courseId, title, parsedTime.toISOString(), repeat, Number(enabled)];
    }

    function requireUser(req) {
        const token = parseCookies(req.headers.cookie).study_session;
        if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, '请先登录');
        const now = new Date().toISOString();
        const row = db.prepare(`
            SELECT u.id, u.username, u.display_name
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?
        `).get(hashToken(token), now);
        if (!row) throw new HttpError(401, '登录已过期，请重新登录');
        return row;
    }

    function startSession(req, res, userId) {
        const oldToken = parseCookies(req.headers.cookie).study_session;
        const token = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
        transaction(() => {
            if (oldToken && /^[a-f0-9]{64}$/.test(oldToken)) {
                db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(oldToken));
            }
            db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
            db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expiry);
        });
        res.setHeader('Set-Cookie', `study_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`);
    }

    async function generatePlanning(userId, body) {
        const aiConfig = getAiConfig();
        if (!aiConfig.apiKey) throw new HttpError(503, '尚未配置 AI API Key，请检查 data/ai-config.json');
        const level = body.level;
        if (!['weekly', 'midterm', 'longterm'].includes(level)) throw new HttpError(400, '计划层级不正确');
        const title = textField(body.title, '计划主题', 120, true);
        const category = textField(body.category, '计划分类', 30);
        const goal = textField(body.goal, '目标', 2000);
        const startDate = textField(body.startDate, '开始日期', 10);
        const endDate = textField(body.endDate, '结束日期', 10);
        const courseNames = Array.isArray(body.courses) ? body.courses.map(value => String(value)).filter(Boolean).slice(0, 20) : [];
        const levelLabel = { weekly: '每周计划', midterm: '中期计划', longterm: '长期计划' }[level];

        const systemPrompt = '你是一名专业的学习规划助手，负责根据学生的目标与课程情况生成清晰、可执行的学习计划。请使用中文回答，内容务实、具体、可落地。';
        const userPrompt = `请根据以下信息生成一份“${levelLabel}”的学习规划。

计划主题：${title}
${category ? `计划分类：${category}` : ''}
计划目标：${goal || '（未填写，请根据主题合理推断）'}
参照课程分类：${courseNames.length ? courseNames.join('、') : '（未提供，请按通用学习安排）'}

请按照以下结构输出纯文本（不要使用 Markdown 语法，用数字序号分行即可）：

一、明确目标与学习路线
（说明这一层级计划的总体目标，以及达成目标的学习路线）

二、将大目标拆解为小任务
（列出若干具体、可执行的小任务，每项包含任务描述、建议的科目/内容、建议完成时间）

三、分层级安排
（分为“每周任务”“中期安排”“长期方向”三部分，说明在这一计划层级内如何推进）

四、打卡与凭证建议
（针对每个小任务，建议如何设置打卡任务、可以上传什么图片作为完成凭证）

请确保内容与该层级的周期相匹配：每周计划聚焦 1 周内可完成的任务，中期计划聚焦约 1 个月的目标，长期计划聚焦本学期/数月的方向。`;

        const enrichedUserPrompt = `${userPrompt}
补充约束：计划时间为 ${startDate || '未设置'} 至 ${endDate || '未设置'}。请让任务密度与该时间范围匹配，并优先使用当前课程中的具体名称和知识方向。`;

        const qualitySystemPrompt = `你是一名计算机科学与软件工程领域的资深学习规划导师，同时具备课程设计、算法训练、软件项目指导和考试复习经验。
你的任务不是输出泛泛的励志建议，而是基于学生提供的真实课程、分类、目标和时间范围，设计一份个性化、可执行、可验收的学习规划。
请先在内部分析目标涉及的知识域、课程之间的前置依赖和适合当前层级的任务粒度，再输出结果。重点覆盖程序设计、数据结构与算法、数据库、操作系统、计算机网络、软件工程、计算机组成、人工智能、数学基础和项目实践等计算机专业知识，并只选择与输入相关的内容。
每个任务必须包含明确动作、范围或数量、完成标准和建议时间，例如完成指定章节、完成题量、通过测试、提交代码或整理笔记。计划要安排理解、练习、复盘和机动时间，识别难点与常见误区，避免空洞建议、机械平均分配和编造学生未提供的成绩或基础。
请使用简体中文，内容专业、具体、克制；信息不足时明确写出合理假设和可调整方案。`;

        let content;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 60000);
            const response = await fetch(aiConfig.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${aiConfig.apiKey}`
                },
                body: JSON.stringify({
                    model: aiConfig.model,
                    messages: [
                        { role: 'system', content: qualitySystemPrompt },
                        { role: 'user', content: enrichedUserPrompt }
                    ],
                    temperature: 0.7
                }),
                signal: controller.signal
            });
            clearTimeout(timer);
            if (!response.ok) {
                const text = await response.text();
                throw new HttpError(502, `AI 规划生成失败：${response.status}（${text.slice(0, 120)}）`);
            }
            const payload = await response.json();
            content = payload?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) {
                throw new HttpError(502, 'AI 未返回有效内容，请稍后重试');
            }
        } catch (error) {
            if (error instanceof HttpError) throw error;
            if (error.name === 'AbortError') throw new HttpError(504, 'AI 规划生成超时，请稍后重试');
            throw new HttpError(502, '无法连接 AI 服务，请检查网络后重试');
        }
        return { level, title, category, aiPlanning: content.trim() };
    }

    async function chatWithAi(body) {
        const aiConfig = getAiConfig();
        if (!aiConfig.apiKey) throw new HttpError(503, '尚未配置 AI API Key，请检查 data/ai-config.json');
        const messages = Array.isArray(body.messages)
            ? body.messages.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').slice(-12)
            : [];
        if (!messages.length || messages[messages.length - 1].role !== 'user') throw new HttpError(400, '请输入学习问题');
        const system = '你是计算机科学与软件工程领域的学习规划助手。请结合对话上下文，针对学生的课程、目标和学习困难给出具体、可执行、个性化的建议。优先给出知识依赖、练习方式、可量化任务和验收标准；信息不足时先提出关键澄清问题。使用简体中文，避免空泛鼓励。';
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 60000);
            const response = await fetch(aiConfig.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.apiKey}` },
                body: JSON.stringify({ model: aiConfig.model, messages: [{ role: 'system', content: system }, ...messages], temperature: 0.7 }),
                signal: controller.signal
            });
            clearTimeout(timer);
            if (!response.ok) {
                const text = await response.text();
                throw new HttpError(502, `AI 对话生成失败：${response.status}（${text.slice(0, 180)}）`);
            }
            const payload = await response.json();
            const content = payload?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) throw new HttpError(502, 'AI 未返回有效内容');
            return { content: content.trim() };
        } catch (error) {
            if (error instanceof HttpError) throw error;
            if (error.name === 'AbortError') throw new HttpError(504, 'AI 对话生成超时，请稍后重试');
            throw new HttpError(502, '无法连接 AI 服务，请检查网络或配置');
        }
    }

    function handleUpload(req, userId) {
        return new Promise((resolve, reject) => {
            const contentType = (req.headers['content-type'] || '').toLowerCase();
            if (!contentType.startsWith('image/')) {
                req.resume();
                reject(new HttpError(400, '请上传图片格式的凭证'));
                return;
            }
            const mime = contentType.split(';')[0].trim();
            const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[mime] || '.jpg';
            const chunks = [];
            let bytes = 0;
            let exceeded = false;
            req.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_IMAGE_BYTES) {
                    if (!exceeded) reject(new HttpError(413, '图片不能超过 8MB'));
                    exceeded = true;
                    chunks.length = 0;
                    return;
                }
                if (!exceeded) chunks.push(chunk);
            });
            req.on('end', () => {
                if (exceeded) return;
                if (!bytes) { reject(new HttpError(400, '图片内容为空')); return; }
                const userDir = path.join(UPLOAD_DIR, String(userId));
                try {
                    fs.mkdirSync(userDir, { recursive: true });
                    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
                    fs.writeFileSync(path.join(userDir, filename), Buffer.concat(chunks));
                    resolve({ url: `/api/uploads/${userId}/${filename}`, filename });
                } catch (error) {
                    reject(new HttpError(500, '图片保存失败，请稍后重试'));
                }
            });
            req.on('aborted', () => reject(new HttpError(400, '请求已中断')));
            req.on('error', () => reject(new HttpError(400, '读取图片失败')));
        });
    }

    function serveUpload(res, userId, filename) {
        if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            throw new HttpError(404, '图片不存在');
        }
        const filePath = path.join(UPLOAD_DIR, String(userId), filename);
        if (!filePath.startsWith(UPLOAD_DIR + path.sep)) throw new HttpError(404, '图片不存在');
        let content;
        try {
            content = fs.readFileSync(filePath);
        } catch (error) {
            throw new HttpError(404, '图片不存在');
        }
        const ext = path.extname(filename).toLowerCase();
        const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
        res.writeHead(200, {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Content-Length': content.length,
            'Cache-Control': 'private, max-age=3600'
        });
        res.end(content);
    }

    async function authRoute(req, res, route) {
        if (route === '/api/auth/me' && req.method === 'GET') {
            sendJson(res, 200, { data: publicUser(requireUser(req)) });
            return true;
        }
        if (route === '/api/plans/ai' && req.method === 'POST') {
            const user = requireUser(req);
            const body = await readJson(req);
            const generated = await generatePlanning(user.id, body);
            sendJson(res, 200, { data: generated });
            return true;
        }
        if (route === '/api/ai/chat' && req.method === 'POST') {
            requireUser(req);
            const body = await readJson(req);
            sendJson(res, 200, { data: await chatWithAi(body) });
            return true;
        }
        if (route === '/api/uploads' && req.method === 'POST') {
            const user = requireUser(req);
            const result = await handleUpload(req, user.id);
            sendJson(res, 201, { data: result });
            return true;
        }
        if (route.startsWith('/api/uploads/') && req.method === 'GET') {
            const user = requireUser(req);
            const filename = decodeURIComponent(route.slice('/api/uploads/'.length));
            serveUpload(res, user.id, filename);
            return true;
        }
        if (route === '/api/auth/logout' && req.method === 'POST') {
            await readJson(req);
            const token = parseCookies(req.headers.cookie).study_session;
            if (token && /^[a-f0-9]{64}$/.test(token)) {
                db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
            }
            res.setHeader('Set-Cookie', 'study_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
            sendJson(res, 200, { data: { message: '已退出登录' } });
            return true;
        }
        if (!['/api/auth/register', '/api/auth/login'].includes(route) || req.method !== 'POST') return false;
        const body = await readJson(req);
        const username = textField(body.username, '账号', 20, true);
        if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, '账号须为3到20位英文字母、数字或下划线');
        if (typeof body.password !== 'string' || body.password.length < 6 || body.password.length > 64 || !body.password.trim()) {
            throw new HttpError(400, '密码长度须为6到64位');
        }
        let user;
        if (route === '/api/auth/register') {
            const displayName = textField(body.displayName, '昵称', 30) || username;
            const salt = crypto.randomBytes(16).toString('hex');
            const passwordHash = (await scrypt(body.password, salt, 64)).toString('hex');
            try {
                const result = db.prepare(`
                    INSERT INTO users (username, display_name, password_salt, password_hash, created_at)
                    VALUES (?, ?, ?, ?, ?)
                `).run(username, displayName, salt, passwordHash, new Date().toISOString());
                user = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
            } catch (error) {
                if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: users.username/.test(error.message)) {
                    throw new HttpError(409, '该账号已被注册');
                }
                throw error;
            }
        } else {
            user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
            const salt = user ? user.password_salt : '00000000000000000000000000000000';
            const passwordHash = await scrypt(body.password, salt, 64);
            if (!user || !crypto.timingSafeEqual(passwordHash, Buffer.from(user.password_hash, 'hex'))) {
                throw new HttpError(401, '账号或密码不正确');
            }
        }
        startSession(req, res, user.id);
        sendJson(res, route === '/api/auth/register' ? 201 : 200, { data: publicUser(user) });
        return true;
    }

    function stats(userId) {
        const courses = getCourses(userId);
        const date = today();
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        const monday = shiftDate(date, -(weekday === 0 ? 6 : weekday - 1));
        const totals = db.prepare(`
            SELECT COALESCE(SUM(duration), 0) AS totalMinutes,
                   COALESCE(SUM(CASE WHEN study_date >= ? THEN duration ELSE 0 END), 0) AS weekMinutes,
                   COALESCE(SUM(CASE WHEN study_date = ? THEN duration ELSE 0 END), 0) AS todayMinutes
            FROM records WHERE user_id = ?
        `).get(monday, date, userId);
        const days = db.prepare(`
            SELECT study_date AS date, SUM(duration) AS minutes FROM records
            WHERE user_id = ? GROUP BY study_date ORDER BY study_date DESC
        `).all(userId);
        const minutesByDay = new Map(days.map(row => [row.date, row.minutes]));
        let streakDays = 0;
        let cursor = minutesByDay.has(date) ? date : shiftDate(date, -1);
        while (minutesByDay.has(cursor)) {
            streakDays++;
            cursor = shiftDate(cursor, -1);
        }
        const totalTarget = courses.reduce((sum, course) => sum + course.targetMinutes, 0);
        const countedMinutes = courses.reduce((sum, course) => sum + Math.min(course.completedMinutes, course.targetMinutes), 0);
        const activeReminders = db.prepare('SELECT COUNT(*) AS count FROM reminders WHERE user_id = ? AND enabled = 1 AND done = 0').get(userId).count;
        return {
            courseCount: courses.length,
            ...totals,
            completedCourses: courses.filter(course => course.status === '已完成').length,
            overallProgress: totalTarget ? progressFor(countedMinutes, totalTarget) : 0,
            activeReminders,
            streakDays,
            weekly: Array.from({ length: 7 }, (_, index) => {
                const day = shiftDate(date, index - 6);
                return { date: day, minutes: minutesByDay.get(day) || 0 };
            }),
            byCourse: courses.map(course => ({
                courseId: course.id, name: course.name, minutes: course.completedMinutes,
                targetMinutes: course.targetMinutes, progress: course.progress
            }))
        };
    }

    async function apiRoute(req, res, route) {
        if (route === '/api/health' && req.method === 'GET') {
            sendJson(res, 200, { data: { app: 'study-course-manager', version: '1.0.0', instance: INSTANCE_ID, pid: process.pid } });
            return;
        }
        if (await authRoute(req, res, route)) return;
        const user = requireUser(req);
        const userId = user.id;
        if (route === '/api/stats' && req.method === 'GET') {
            sendJson(res, 200, { data: stats(userId) });
            return;
        }
        if (route === '/api/reminders/read' && req.method === 'POST') {
            const body = await readJson(req);
            if (!Array.isArray(body.items) || !body.items.length || body.items.length > 1000) {
                throw new HttpError(400, '请选择需要标记已读的提醒');
            }
            const items = body.items.map(item => {
                if (!item || !Number.isSafeInteger(item.id) || typeof item.dueAt !== 'string') {
                    throw new HttpError(400, '提醒信息不正确');
                }
                const reminder = getReminders(userId, item.id)[0];
                if (!reminder) throw new HttpError(404, '未找到该项数据');
                return { reminder, dueAt: item.dueAt };
            });
            const now = Date.now();
            transaction(() => {
                for (const { reminder, dueAt } of items) {
                    if (reminder.dueAt !== dueAt || !reminder.enabled || reminder.done ||
                        reminder.readDueAt === dueAt || Date.parse(dueAt) > now) continue;
                    if (reminder.repeat === 'none') {
                        db.prepare('UPDATE reminders SET read_due_at = ? WHERE id = ? AND user_id = ?')
                            .run(dueAt, reminder.id, userId);
                    } else {
                        const interval = reminder.repeat === 'daily' ? DAY_MS : 7 * DAY_MS;
                        const next = Date.parse(dueAt) + (Math.floor((now - Date.parse(dueAt)) / interval) + 1) * interval;
                        db.prepare('UPDATE reminders SET due_at = ?, read_due_at = NULL WHERE id = ? AND user_id = ?')
                            .run(new Date(next).toISOString(), reminder.id, userId);
                    }
                }
            });
            sendJson(res, 200, { data: getReminders(userId) });
            return;
        }
        const plansMatch = route.match(/^\/api\/plans\/(\d+)\/tasks(?:\/(\d+))?$/);
        if (plansMatch) {
            const planId = resourceId(plansMatch[1]);
            requirePlan(userId, planId);
            const taskId = plansMatch[2] === undefined ? undefined : resourceId(plansMatch[2]);
            const tasks = () => getPlanTasks(userId, planId);
            if (req.method === 'GET' && taskId === undefined) {
                sendJson(res, 200, { data: tasks() });
                return;
            }
            if (req.method === 'POST' && taskId === undefined) {
                const body = await readJson(req);
                const values = planTaskInput(body);
                const result = db.prepare(`
                    INSERT INTO plan_tasks (user_id, plan_id, subject, goal, due_date, completed, proof_image, note, sort_order, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(userId, planId, values.subject, values.goal, values.dueDate, Number(values.completed), values.proofImage, values.note, Number(sortOrderFor(userId, planId)), new Date().toISOString());
                sendJson(res, 201, { data: getPlanTasksReturn(userId, Number(result.lastInsertRowid)) });
                return;
            }
            if (taskId !== undefined) {
                const existing = tasks().find(task => task.id === taskId);
                if (!existing) throw new HttpError(404, '任务不存在，请重新选择');
                if (req.method === 'PUT') {
                    const body = await readJson(req);
                    const values = planTaskInput(body);
                    db.prepare(`
                        UPDATE plan_tasks SET subject = ?, goal = ?, due_date = ?, completed = ?, proof_image = ?, note = ?
                        WHERE id = ? AND user_id = ?
                    `).run(values.subject, values.goal, values.dueDate, Number(values.completed), values.proofImage, values.note, taskId, userId);
                    sendJson(res, 200, { data: getPlanTasksReturn(userId, taskId) });
                    return;
                }
                if (req.method === 'DELETE') {
                    db.prepare('DELETE FROM plan_tasks WHERE id = ? AND user_id = ?').run(taskId, userId);
                    sendJson(res, 200, { data: { message: '已删除' } });
                    return;
                }
            }
            throw new HttpError(405, '不支持该请求方式');
        }

        const plansOnlyMatch = route.match(/^\/api\/plans(?:\/(\d+))?$/);
        if (plansOnlyMatch) {
            const id = plansOnlyMatch[1] === undefined ? undefined : resourceId(plansOnlyMatch[1]);
            const levelFilter = null;
            if (req.method === 'GET' && id === undefined) {
                sendJson(res, 200, { data: getPlans(userId) });
                return;
            }
            if (req.method === 'GET' && id !== undefined) {
                sendJson(res, 200, { data: getPlanDetail(userId, id) });
                return;
            }
            if (id !== undefined && !getPlans(userId, id).length) throw new HttpError(404, '未找到该项数据');
            if (req.method === 'DELETE' && id !== undefined) {
                db.prepare('DELETE FROM study_plans WHERE id = ? AND user_id = ?').run(id, userId);
                sendJson(res, 200, { data: { message: '已删除' } });
                return;
            }
            const creating = req.method === 'POST' && id === undefined;
            const updating = req.method === 'PUT' && id !== undefined;
            if (!creating && !updating) throw new HttpError(405, '不支持该请求方式');
            const body = await readJson(req);
            const values = planInput(body);
            const now = new Date().toISOString();
            if (creating) {
                const result = db.prepare(`
                    INSERT INTO study_plans (user_id, level, title, category, goal, start_date, end_date, ai_planning, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(userId, values.level, values.title, values.category, values.goal, values.startDate, values.endDate, values.aiPlanning, values.status, now);
                sendJson(res, 201, { data: getPlans(userId, Number(result.lastInsertRowid))[0] });
                return;
            }
            db.prepare(`
                UPDATE study_plans SET level = ?, title = ?, category = ?, goal = ?, start_date = ?, end_date = ?, ai_planning = ?, status = ?
                WHERE id = ? AND user_id = ?
            `).run(values.level, values.title, values.category, values.goal, values.startDate, values.endDate, values.aiPlanning, values.status, id, userId);
            sendJson(res, 200, { data: getPlans(userId, id)[0] });
            return;
        }

        const match = route.match(/^\/api\/(courses|records|reminders)(?:\/(\d+))?(?:\/(complete))?$/);
        if (!match || (match[3] && (match[1] !== 'reminders' || !match[2]))) {
            throw new HttpError(404, '接口不存在');
        }
        const resource = match[1];
        const id = match[2] === undefined ? undefined : resourceId(match[2]);
        const isComplete = match[3] === 'complete';
        const getter = { courses: getCourses, records: getRecords, reminders: getReminders }[resource];

        if (req.method === 'GET' && id === undefined && !isComplete) {
            sendJson(res, 200, { data: getter(userId) });
            return;
        }
        if (id !== undefined && !getter(userId, id).length) throw new HttpError(404, '未找到该项数据');
        if (req.method === 'DELETE' && id !== undefined && !isComplete) {
            db.prepare(`DELETE FROM ${resource} WHERE id = ? AND user_id = ?`).run(id, userId);
            sendJson(res, 200, { data: { message: '已删除' } });
            return;
        }
        if (resource === 'reminders' && isComplete && req.method === 'POST') {
            await readJson(req);
            const reminder = getReminders(userId, id)[0];
            if (reminder.repeat === 'none') {
                db.prepare('UPDATE reminders SET done = 1 WHERE id = ? AND user_id = ?').run(id, userId);
            } else {
                const interval = reminder.repeat === 'daily' ? DAY_MS : 7 * DAY_MS;
                let nextTime = new Date(reminder.dueAt).getTime() + interval;
                if (nextTime <= Date.now()) nextTime += (Math.floor((Date.now() - nextTime) / interval) + 1) * interval;
                db.prepare('UPDATE reminders SET due_at = ?, done = 0 WHERE id = ? AND user_id = ?')
                    .run(new Date(nextTime).toISOString(), id, userId);
            }
            sendJson(res, 200, { data: getReminders(userId, id)[0] });
            return;
        }
        const creating = req.method === 'POST' && id === undefined && !isComplete;
        const updating = req.method === 'PUT' && id !== undefined && !isComplete;
        if (!creating && !updating) throw new HttpError(405, '不支持该请求方式');
        const body = await readJson(req);
        const now = new Date().toISOString();
        let savedId = id;
        if (resource === 'courses') {
            const values = courseInput(body);
            if (creating) {
                savedId = Number(db.prepare(`
                    INSERT INTO courses (user_id, name, category, teacher, description, target_minutes, deadline, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(userId, ...values, now).lastInsertRowid);
            } else {
                db.prepare(`
                    UPDATE courses SET name = ?, category = ?, teacher = ?, description = ?, target_minutes = ?, deadline = ?
                    WHERE id = ? AND user_id = ?
                `).run(...values, id, userId);
            }
        } else if (resource === 'records') {
            const values = recordInput(body, userId);
            if (creating) {
                savedId = Number(db.prepare(`
                    INSERT INTO records (user_id, course_id, study_date, duration, content, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(userId, ...values, now).lastInsertRowid);
            } else {
                db.prepare(`
                    UPDATE records SET course_id = ?, study_date = ?, duration = ?, content = ?
                    WHERE id = ? AND user_id = ?
                `).run(...values, id, userId);
            }
        } else {
            const values = reminderInput(body, userId);
            if (creating) {
                savedId = Number(db.prepare(`
                    INSERT INTO reminders (user_id, course_id, title, due_at, repeat_rule, enabled, done, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
                `).run(userId, ...values, now).lastInsertRowid);
            } else {
                db.prepare(`
                    UPDATE reminders SET course_id = ?, title = ?, due_at = ?, repeat_rule = ?, enabled = ?, done = 0
                    WHERE id = ? AND user_id = ?
                `).run(...values, id, userId);
            }
        }
        sendJson(res, creating ? 201 : 200, { data: getter(userId, savedId)[0] });
    }

    async function staticFile(req, res, route) {
        if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, '不支持该请求方式');
        let decoded;
        try {
            decoded = decodeURIComponent(route);
        } catch (_) {
            throw new HttpError(400, '页面地址不正确');
        }
        if (decoded.includes('\0') || decoded.includes('\\')) throw new HttpError(400, '页面地址不正确');
        const filePath = path.resolve(PUBLIC_DIR, `.${decoded === '/' ? '/index.html' : decoded}`);
        if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, '页面不存在');
        let content;
        try {
            const realPath = await fs.promises.realpath(filePath);
            if (!realPath.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, '页面不存在');
            if (!(await fs.promises.stat(realPath)).isFile()) throw new HttpError(404, '页面不存在');
            content = await fs.promises.readFile(realPath);
        } catch (error) {
            if (error instanceof HttpError) throw error;
            if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) throw new HttpError(404, '页面不存在');
            throw error;
        }
        const mimeTypes = {
            '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
            '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
        };
        res.writeHead(200, {
            'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Content-Length': content.length,
            'Cache-Control': 'no-cache'
        });
        res.end(req.method === 'HEAD' ? undefined : content);
    }

    const server = http.createServer(async (req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            const route = url.pathname;
            if (route.startsWith('/api/')) {
                if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
                    let origin;
                    try {
                        origin = new URL(req.headers.origin);
                    } catch (_) {
                        throw new HttpError(403, '请在系统页面中提交操作');
                    }
                    if (origin.protocol !== 'http:' || origin.host !== req.headers.host) {
                        throw new HttpError(403, '请在系统页面中提交操作');
                    }
                }
                await apiRoute(req, res, route);
            } else {
                await staticFile(req, res, route);
            }
        } catch (error) {
            if (!(error instanceof HttpError)) console.error('请求处理失败：', error);
            sendJson(res, error instanceof HttpError ? error.status : 500, {
                error: error instanceof HttpError ? error.message : '服务暂时无法处理请求，请稍后重试'
            });
        }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;

    let closing = false;
    function close() {
        if (closing) return Promise.resolve();
        closing = true;
        return new Promise(resolve => {
            const finish = () => {
                db.close();
                resolve();
            };
            if (!server.listening) finish();
            else {
                server.close(finish);
                server.closeIdleConnections();
            }
        });
    }
    return { server, close };
}

if (require.main === module) {
    const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error('PORT 必须是 1 到 65535 之间的整数。');
        process.exitCode = 1;
    } else {
        const app = createApp();
        app.server.on('error', async error => {
            console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请关闭已启动的服务或更换 PORT。` : `服务启动失败：${error.message}`);
            await app.close();
            process.exitCode = 1;
        });
        app.server.listen(port, '127.0.0.1', () => {
            console.log(`学习计划与课程管理系统已启动：http://127.0.0.1:${port}`);
        });
        for (const signal of ['SIGINT', 'SIGTERM']) {
            process.once(signal, async () => {
                await app.close();
                process.exit(0);
            });
        }
    }
}

module.exports = { createApp };
