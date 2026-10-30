'use strict';

const DEMO_DATA_VERSION = 1;

const courseTemplates = [
    {
        key: 'operatingSystems', name: '操作系统', category: '专业课程', teacher: '示例教师',
        description: '掌握进程调度、同步与内存管理，完成课后习题和实验。',
        targetMinutes: 1500, deadlineDays: 25,
        activities: [
            [60, '整理进程与线程的区别，画出进程状态转换图。'],
            [45, '比较先来先服务、短作业优先和时间片轮转调度。'],
            [50, '练习互斥锁与信号量，分析生产者消费者问题。'],
            [45, '复习死锁产生条件，完成银行家算法习题。'],
            [75, '整理分页、分段和页表结构，练习地址转换。'],
            [60, '模拟 FIFO 与 LRU 页面置换，计算缺页次数。'],
            [50, '复习文件目录与磁盘空间分配方法。'],
            [55, '比较磁盘调度算法，整理实验结果。'],
            [60, '重做进程同步错题，补充操作系统复习笔记。']
        ]
    },
    {
        key: 'networks', name: '计算机网络', category: '专业课程', teacher: '示例教师',
        description: '学习网络分层、TCP/IP 协议和常见网络配置，完成协议分析练习。',
        targetMinutes: 1200, deadlineDays: 20,
        activities: [
            [45, '整理网络分层模型，比较各层的主要职责。'],
            [60, '练习 IPv4 子网划分，计算网络地址和广播地址。'],
            [50, '复习 ARP 与 ICMP，使用 ping 检查网络连通性。'],
            [45, '比较交换机与路由器，整理转发表与路由表。'],
            [60, '分析 TCP 三次握手与四次挥手的过程。'],
            [50, '复习滑动窗口、流量控制与拥塞控制。'],
            [55, '比较 TCP 与 UDP，完成传输层课后练习。'],
            [65, '抓取 HTTP 请求，观察请求头与响应状态码。'],
            [60, '整理 DNS 查询流程，重做网络协议相关错题。']
        ]
    },
    {
        key: 'java', name: 'Java 程序设计', category: '实验课程', teacher: '示例教师',
        description: '完成面向对象与集合框架复习，巩固异常处理和文件读写。',
        targetMinutes: 600, deadlineDays: -2,
        activities: [
            [60, '复习类与对象，完成学生信息类的封装练习。'],
            [75, '练习继承和接口，比较方法重载与方法重写。'],
            [60, '整理异常处理规则，完成输入校验练习。'],
            [80, '使用 ArrayList 和 HashMap 实现课程信息存储。'],
            [75, '练习 Comparator，按学习时长排序课程。'],
            [90, '完成文件读写练习，保存和读取课程文本数据。'],
            [80, '复习泛型，整理集合框架的常用操作。'],
            [80, '完成 Java 综合练习，检查边界输入与异常处理。']
        ]
    },
    {
        key: 'web', name: 'Web 应用开发', category: '实验课程', teacher: '示例教师',
        description: '练习 HTML、CSS 与 JavaScript，完成表单交互和接口请求。',
        targetMinutes: 1080, deadlineDays: 14,
        activities: [
            [50, '使用 HTML 编写课程列表与学习记录表单。'],
            [60, '练习 CSS 布局，调整导航栏、表格和表单样式。'],
            [80, '编写 JavaScript 表单校验，检查必填项和日期。'],
            [45, '整理 DOM 事件，完成按钮点击与弹窗交互。'],
            [70, '使用 fetch 请求课程接口，处理加载与错误状态。'],
            [65, '完成课程搜索与分类筛选，检查空列表显示。'],
            [55, '练习表格数据渲染，检查特殊字符的显示。'],
            [75, '联调登录表单，检查成功跳转与错误提示。']
        ]
    },
    {
        key: 'algorithms', name: '算法设计与分析', category: '专业课程', teacher: '示例教师',
        description: '复习分治、贪心和动态规划，练习复杂度分析与典型题目。',
        targetMinutes: 1200, deadlineDays: 28,
        activities: [
            [60, '复习时间复杂度与空间复杂度，完成递归分析题。'],
            [55, '练习二分查找，检查左右边界和空数组情况。'],
            [70, '实现归并排序，分析分治过程与辅助空间。'],
            [60, '完成区间调度题，验证贪心选择的正确性。'],
            [50, '练习背包问题，整理状态定义和状态转移。'],
            [65, '求解最长公共子序列，绘制动态规划表。'],
            [75, '实现 Dijkstra 算法，测试不同起点的最短路径。'],
            [55, '整理算法错题，重做动态规划边界条件练习。']
        ]
    },
    {
        key: 'architecture', name: '计算机组成原理', category: '专业课程', teacher: '示例教师',
        description: '复习数据表示、运算器、存储系统与指令执行过程。',
        targetMinutes: 960, deadlineDays: 18,
        activities: [
            [45, '复习原码、反码与补码，完成整数表示练习。'],
            [60, '练习定点运算，检查溢出判断与进位处理。'],
            [50, '整理浮点数表示，完成阶码与尾数转换练习。'],
            [55, '复习 Cache 映射方式，计算命中率与访问时间。'],
            [45, '分析一条指令的取指、译码和执行过程。'],
            [60, '比较单周期与流水线，整理数据相关和控制相关。'],
            [55, '复习中断与 DMA，完成输入输出系统习题。']
        ]
    },
    {
        key: 'linux', name: 'Linux 应用基础', category: '拓展学习', teacher: '示例教师',
        description: '掌握常见终端命令、文件权限和进程查看，完成基础操作练习。',
        targetMinutes: 360, deadlineDays: -1,
        activities: [
            [60, '练习目录与文件操作，整理常用终端命令。'],
            [75, '完成用户、用户组和文件权限设置练习。'],
            [80, '使用管道与重定向处理文本，练习日志筛选。'],
            [70, '查看进程与端口，练习服务启动和停止。'],
            [75, '编写基础 Shell 脚本，完成文件备份与执行检查。']
        ]
    },
    {
        key: 'security', name: '信息安全导论', category: '专业课程', teacher: '示例教师',
        description: '计划学习密码学基础、身份验证和常见 Web 安全问题。',
        targetMinutes: 900, deadlineDays: 40, activities: []
    },
    {
        key: 'compiler', name: '编译原理', category: '专业课程', teacher: '示例教师',
        description: '计划复习词法分析、语法分析和中间代码，完成基础编译实验。',
        targetMinutes: 1500, deadlineDays: 45, activities: []
    },
    {
        key: 'testing', name: '软件测试', category: '专业课程', teacher: '示例教师',
        description: '计划练习等价类划分、边界值分析和接口测试。',
        targetMinutes: 720, deadlineDays: 35, activities: []
    },
    {
        key: 'python', name: 'Python 程序设计', category: '拓展学习', teacher: '示例教师',
        description: '计划练习文件处理、数据统计和简单脚本编写。',
        targetMinutes: 900, deadlineDays: 38, activities: []
    },
    {
        key: 'projectManagement', name: '软件项目管理', category: '专业课程', teacher: '示例教师',
        description: '计划学习项目分工、进度安排和开发过程管理。',
        targetMinutes: 600, deadlineDays: 42, activities: []
    }
];

const reminderTemplates = [
    { courseKey: 'operatingSystems', title: '复习进程调度与同步', days: 1, time: '19:00', repeat: 'none' },
    { courseKey: 'networks', title: '完成 TCP 与 UDP 习题', days: 2, time: '20:00', repeat: 'none' },
    { courseKey: 'web', title: '继续完成课程页面练习', days: 1, time: '20:30', repeat: 'daily' },
    { courseKey: 'algorithms', title: '每周整理算法错题', days: 3, time: '10:00', repeat: 'weekly' },
    { courseKey: 'architecture', title: '复习 Cache 与地址映射', days: 4, time: '19:30', repeat: 'none' },
    { courseKey: null, title: '整理本周学习记录', days: 5, time: '16:00', repeat: 'weekly' },
    { courseKey: 'java', title: '完成 Java 集合练习', days: -2, time: '20:00', repeat: 'none', done: true },
    { courseKey: 'linux', title: '复习 Linux 文件权限', days: 2, time: '18:30', repeat: 'daily', enabled: false },
    { courseKey: null, title: '每周检查课程完成进度', days: 6, time: '20:30', repeat: 'weekly' },
    { courseKey: 'operatingSystems', title: '复习内存分页与分段', days: 7, time: '19:15', repeat: 'none' }
];

function shiftDate(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function getToday() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
}

function emptyResult(upgraded = false) {
    return { upgraded, coursesAdded: 0, recordsAdded: 0, remindersAdded: 0 };
}

// 演示账号的数据只扩充一次，保留已有课程和用户修改。
function upgradeDemoData(db, options = {}) {
    const version = () => db.prepare('PRAGMA user_version').get().user_version;
    if (version() >= DEMO_DATA_VERSION) return emptyResult();
    const today = options.today || getToday();
    if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today) || shiftDate(today, 0) !== today) {
        throw new Error('演示数据基准日期不正确');
    }

    db.exec('BEGIN IMMEDIATE');
    try {
        // 事务内再次检查，避免同时启动时重复扩充。
        if (version() >= DEMO_DATA_VERSION) {
            db.exec('COMMIT');
            return emptyResult();
        }
        const user = db.prepare("SELECT id FROM users WHERE username = 'student'").get();
        const result = emptyResult(true);
        if (user) {
            const existingCourses = db.prepare('SELECT name FROM courses WHERE user_id = ?').all(user.id);
            const existingNames = new Set(existingCourses.map(course => course.name));
            const recordCount = db.prepare('SELECT COUNT(*) AS count FROM records WHERE user_id = ?').get(user.id).count;
            const reminderCount = db.prepare('SELECT COUNT(*) AS count FROM reminders WHERE user_id = ?').get(user.id).count;
            const courseCount = Math.max(9, 12 - existingCourses.length);
            const templates = courseTemplates.slice(0, courseCount);
            const courseIds = new Map();
            const now = new Date().toISOString();
            const insertCourse = db.prepare(`
                INSERT INTO courses (user_id, name, category, teacher, description, target_minutes, deadline, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const course of templates) {
                let name = course.name;
                let suffix = 1;
                while (existingNames.has(name)) {
                    name = course.name + (suffix === 1 ? '复习' : `复习（${suffix}）`);
                    suffix++;
                }
                const id = Number(insertCourse.run(user.id, name, course.category, course.teacher,
                    course.description, course.targetMinutes, shiftDate(today, course.deadlineDays), now).lastInsertRowid);
                existingNames.add(name);
                courseIds.set(course.key, id);
                result.coursesAdded++;
            }

            // 交错安排各科目，使最近 28 天都有学习记录。
            const activities = [];
            for (let index = 0; index < 9; index++) {
                for (const course of templates) {
                    if (course.activities[index]) {
                        const [duration, content] = course.activities[index];
                        activities.push({ courseKey: course.key, duration, content });
                    }
                }
            }
            const recordsToAdd = Math.max(54, 60 - recordCount);
            const reviewCourses = templates.filter(course => course.activities.length && !['java', 'linux'].includes(course.key));
            const extraContents = [
                '整理本章错题并重做课后练习。', '补充课堂笔记，检查例题中的边界条件。',
                '复习实验步骤，整理遇到的问题与解决方法。', '完成章节复习，记录后续需要巩固的知识点。'
            ];
            while (activities.length < recordsToAdd) {
                const index = activities.length - 54;
                const course = reviewCourses[index % reviewCourses.length];
                activities.push({ courseKey: course.key, duration: 30 + index % 3 * 5,
                    content: `${course.name}：${extraContents[index % extraContents.length]}` });
            }
            const insertRecord = db.prepare(`
                INSERT INTO records (user_id, course_id, study_date, duration, content, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            activities.slice(0, recordsToAdd).forEach((activity, index) => {
                const date = shiftDate(today, -27 + Math.floor(index * 28 / recordsToAdd));
                insertRecord.run(user.id, courseIds.get(activity.courseKey), date, activity.duration, activity.content, now);
                result.recordsAdded++;
            });

            const insertReminder = db.prepare(`
                INSERT INTO reminders (user_id, course_id, title, due_at, repeat_rule, enabled, done, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const remindersToAdd = Math.max(8, 10 - reminderCount);
            for (const reminder of reminderTemplates.slice(0, remindersToAdd)) {
                const dueAt = new Date(`${shiftDate(today, reminder.days)}T${reminder.time}:00+08:00`).toISOString();
                insertReminder.run(user.id, reminder.courseKey ? courseIds.get(reminder.courseKey) : null,
                    reminder.title, dueAt, reminder.repeat, reminder.enabled === false ? 0 : 1, reminder.done ? 1 : 0, now);
                result.remindersAdded++;
            }
        }
        db.exec(`PRAGMA user_version = ${DEMO_DATA_VERSION}`);
        db.exec('COMMIT');
        return result;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

module.exports = { upgradeDemoData, DEMO_DATA_VERSION };
