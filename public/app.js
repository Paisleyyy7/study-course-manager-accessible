(() => {
  'use strict';

  const app = document.getElementById('app');
  const formDialog = document.getElementById('form-dialog');
  const confirmDialog = document.getElementById('confirm-dialog');
  const toastElement = document.getElementById('toast');
  const state = {
    user: null, page: 'courses', courses: [], records: [], reminders: [], plans: [], stats: {},
    filters: { courses: { search: '', status: '', category: '' }, records: { course: '', start: '', end: '' }, reminders: { status: '' }, plans: { level: 'weekly', category: '' } },
    notified: new Set(), notificationEnabled: false, toastTimer: null, polling: false, busy: false,
    recordPage: 1, recordPageSize: 10
  };
  try { state.notificationEnabled = localStorage.getItem('learning-notifications') === 'on'; } catch (_) { /* 浏览器可能禁止本地偏好存储。 */ }

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = value => Number(value) || 0;
  const percent = value => Math.max(0, Math.min(100, number(value)));
  const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const localDateTime = value => {
    const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
    return `${localDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };
  const displayDateTime = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : `${localDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };
  const durationText = minutes => {
    const total = number(minutes);
    if (!total) return '0 分钟';
    const hours = Math.floor(total / 60), rest = total % 60;
    return hours ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}` : `${rest} 分钟`;
  };
  const option = (value, label, selected) => `<option value="${escapeHtml(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const courseOptions = (selected, placeholder = '全部课程') => option('', placeholder, selected) + state.courses.map(course => option(course.id, course.name, selected)).join('');
  const repeatLabel = repeat => ({ none: '一次', daily: '每天', weekly: '每周' }[repeat] || '一次');
  const dueReminders = () => state.reminders.filter(reminder => reminder.enabled && !reminder.done && reminder.readDueAt !== reminder.dueAt && new Date(reminder.dueAt).getTime() <= Date.now());
  const statusTag = status => `<span class="tag ${status === '已完成' ? 'green' : status === '学习中' ? 'blue' : ''}">${escapeHtml(status)}</span>`;
  const navIcon = key => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({courses:'<path d="M4 4h7a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4zM14 7h6v12h-6"/>',records:'<path d="M4 3h16v18H4zM8 7h8M8 11h8M8 15h3m3 0h2"/>',reminders:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',plans:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'})[key]}</svg>`;
  let calendar = null;
  const expandedPlanIds = new Set();

  function dateControl(id, value = '', options = {}) {
    const { name = '', filter = '', required = false, max = '' } = options;
    return `<div class="date-control"><input id="${id}"${name ? ` name="${name}"` : ''} class="${filter ? 'filter-input' : ''}" type="text" readonly placeholder="年 / 月 / 日" value="${escapeHtml(value)}" data-calendar-action="open"${filter ? ` data-filter="${filter}"` : ''}${max ? ` data-max-date="${max}"` : ''}${required ? ' data-date-required="true"' : ''} aria-haspopup="dialog" aria-expanded="false"><button type="button" class="calendar-trigger" data-calendar-action="open" data-target="${id}" aria-label="选择${{ 'record-start': '开始日期', 'record-end': '结束日期', 'form-date': '学习日期', 'form-deadline': '截止日期' }[id] || '日期'}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-12 4h2m3 0h2"/></svg></button></div>`;
  }

  function closeDatePicker(returnFocus = true) {
    if (!calendar) return;
    const input = calendar.input;
    document.getElementById('date-picker')?.remove();
    calendar = null;
    input.setAttribute('aria-expanded', 'false');
    if (returnFocus && input.isConnected) input.focus();
  }

  function renderDatePicker() {
    if (!calendar) return;
    const { input, month } = calendar;
    const year = month.getFullYear(), monthIndex = month.getMonth();
    const start = new Date(year, monthIndex, 1);
    const days = new Date(year, monthIndex + 1, 0).getDate();
    const offset = (start.getDay() + 6) % 7;
    let picker = document.getElementById('date-picker');
    if (!picker) {
      picker = document.createElement('div'); picker.id = 'date-picker';
      picker.className = 'date-picker'; picker.setAttribute('role', 'dialog');
      picker.setAttribute('popover', 'manual');
      picker.setAttribute('aria-label', '选择日期');
      input.parentElement.append(picker);
    }
    picker.innerHTML = `<div class="calendar-header"><button type="button" data-calendar-action="month" data-offset="-1" aria-label="上个月">‹</button><div><select class="calendar-year" aria-label="选择年份">${Array.from({ length: 201 }, (_, i) => option(1900 + i, `${1900 + i}年`, year)).join('')}</select><select class="calendar-month" aria-label="选择月份">${Array.from({ length: 12 }, (_, i) => option(i, `${i + 1}月`, monthIndex)).join('')}</select></div><button type="button" data-calendar-action="month" data-offset="1" aria-label="下个月">›</button></div><div class="calendar-grid calendar-weekdays">${['一', '二', '三', '四', '五', '六', '日'].map(day => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${'<span></span>'.repeat(offset)}${Array.from({ length: days }, (_, i) => {
      const date = localDate(new Date(year, monthIndex, i + 1));
      const disabled = input.dataset.maxDate && date > input.dataset.maxDate;
      return `<button type="button" data-calendar-action="select" data-date="${date}" aria-label="${year}年${monthIndex + 1}月${i + 1}日" class="calendar-day${date === input.value ? ' selected' : ''}${date === localDate() ? ' today' : ''}"${disabled ? ' disabled' : ''}>${i + 1}</button>`;
    }).join('')}</div><div class="calendar-footer"><button type="button" data-calendar-action="clear"${input.dataset.dateRequired ? ' disabled' : ''}>清空</button><button type="button" data-calendar-action="select" data-date="${localDate()}">今天</button><button type="button" data-calendar-action="close">关闭</button></div>`;
    if (picker.showPopover && !picker.matches(':popover-open')) picker.showPopover();
    const bounds = picker.getBoundingClientRect(), anchor = input.getBoundingClientRect();
    const top = anchor.bottom + bounds.height + 6 < innerHeight - 12 ? anchor.bottom + 6 : anchor.top - bounds.height - 6;
    picker.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - bounds.width - 12))}px`;
    picker.style.top = `${Math.max(12, Math.min(top, innerHeight - bounds.height - 12))}px`;
  }

  document.addEventListener('click', event => {
    const control = event.target.closest('[data-calendar-action]');
    if (!control) {
      if (calendar && !event.target.closest('#date-picker')) closeDatePicker(false);
      return;
    }
    const action = control.dataset.calendarAction;
    if (action === 'open') {
      const input = control.tagName === 'INPUT' ? control : document.getElementById(control.dataset.target);
      if (calendar?.input === input) { closeDatePicker(); return; }
      closeDatePicker(false);
      const selected = input.value ? new Date(`${input.value}T00:00:00`) : new Date();
      calendar = { input, month: new Date(selected.getFullYear(), selected.getMonth(), 1) };
      input.setAttribute('aria-expanded', 'true'); renderDatePicker();
      document.querySelector('#date-picker .calendar-day.selected:not(:disabled), #date-picker .calendar-day:not(:disabled)')?.focus();
    } else if (calendar && action === 'month') {
      const next = new Date(calendar.month.getFullYear(), calendar.month.getMonth() + number(control.dataset.offset), 1);
      if (next.getFullYear() < 1900 || next.getFullYear() > 2100) return;
      calendar.month = next; renderDatePicker();
    } else if (calendar && (action === 'select' || action === 'clear')) {
      if (control.disabled) return;
      const input = calendar.input;
      input.value = action === 'clear' ? '' : control.dataset.date;
      closeDatePicker();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (action === 'close') closeDatePicker();
  });
  document.addEventListener('change', event => {
    if (!calendar || !event.target.matches('.calendar-year, .calendar-month')) return;
    const picker = document.getElementById('date-picker');
    calendar.month = new Date(number(picker.querySelector('.calendar-year').value), number(picker.querySelector('.calendar-month').value), 1);
    renderDatePicker();
  });
  document.addEventListener('keydown', event => {
    if (!calendar && event.target.matches('input[data-calendar-action="open"]') && ['Enter', ' ', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); event.target.click(); return;
    }
    if (!calendar) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDatePicker(); }
    if (event.target.matches('.calendar-day') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
      const date = new Date(`${event.target.dataset.date}T00:00:00`); date.setDate(date.getDate() + step);
      if (date.getFullYear() < 1900 || date.getFullYear() > 2100 || (calendar.input.dataset.maxDate && localDate(date) > calendar.input.dataset.maxDate)) return;
      calendar.month = new Date(date.getFullYear(), date.getMonth(), 1); renderDatePicker();
      document.querySelector(`#date-picker [data-date="${localDate(date)}"]`)?.focus();
    }
  }, true);

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    } catch (_) {
      throw new Error('无法连接服务器，请确认服务已经启动后重试。');
    }
    let body;
    try { body = await response.json(); } catch (_) { throw new Error('服务器响应异常，请稍后重试。'); }
    if (!response.ok) {
      const error = new Error(body.error || '操作失败，请稍后重试。');
      error.status = response.status;
      throw error;
    }
    return body.data;
  }

  function toast(message, isError = false) {
    clearTimeout(state.toastTimer);
    toastElement.textContent = message;
    toastElement.className = `toast${isError ? ' error' : ''}`;
    toastElement.hidden = false;
    state.toastTimer = setTimeout(() => { toastElement.hidden = true; }, isError ? 6000 : 3500);
  }

  function authPage(tab = 'login') {
    expandedPlanIds.clear();
    state.user = null;
    app.innerHTML = `<div class="auth-page">
      <header class="auth-header"><div class="brand"><span class="brand-mark" aria-hidden="true">▤</span>学习计划与课程管理系统</div></header>
      <main class="auth-main"><section class="auth-card" aria-labelledby="auth-title">
        <h1 id="auth-title">${tab === 'login' ? '用户登录' : '账号注册'}</h1>
        <div class="auth-tabs" role="group" aria-label="账户操作">
          <button type="button" data-action="auth-tab" data-tab="login" class="auth-tab${tab === 'login' ? ' active' : ''}" aria-pressed="${tab === 'login'}">登录</button>
          <button type="button" data-action="auth-tab" data-tab="register" class="auth-tab${tab === 'register' ? ' active' : ''}" aria-pressed="${tab === 'register'}">注册</button>
        </div>
        <form id="auth-form" data-mode="${tab}">
          <p id="auth-error" class="form-error" role="alert" hidden></p>
          <div class="field"><label for="username">账号<span class="required">*</span></label><input id="username" name="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="username" placeholder="3–20 位英文字母、数字或下划线" title="账号为 3–20 位英文字母、数字或下划线"></div>
          ${tab === 'register' ? '<div class="field"><label for="displayName">昵称</label><input id="displayName" name="displayName" maxlength="30" autocomplete="nickname" placeholder="用于页面显示，可不填写"></div>' : ''}
          <div class="field"><label for="password">密码<span class="required">*</span></label><input id="password" name="password" type="password" required minlength="6" maxlength="64" autocomplete="${tab === 'login' ? 'current-password' : 'new-password'}" placeholder="请输入 6–64 位密码"></div>
          ${tab === 'register' ? '<div class="field"><label for="confirmPassword">确认密码<span class="required">*</span></label><input id="confirmPassword" name="confirmPassword" type="password" required minlength="6" maxlength="64" autocomplete="new-password" placeholder="再次输入密码"></div>' : ''}
          <button class="primary-btn auth-submit" type="submit">${tab === 'login' ? '登录' : '注册并登录'}</button>
        </form>
        <div class="demo-note">演示账号：<strong>student</strong><br>演示密码：<strong>Student123</strong><br>也可以注册自己的账号，单独管理学习数据。</div>
      </section></main>
    </div>`;
    document.getElementById('auth-form').addEventListener('submit', submitAuth);
  }

  async function submitAuth(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const errorBox = document.getElementById('auth-error');
    errorBox.hidden = true;
    if (form.dataset.mode === 'register' && values.password !== values.confirmPassword) {
      errorBox.textContent = '两次输入的密码不一致，请重新确认。';
      errorBox.hidden = false;
      document.getElementById('confirmPassword').focus();
      return;
    }
    const submitButton = form.querySelector('[type="submit"]');
    const previousText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = '正在提交…';
    try {
      state.user = await api(`/api/auth/${form.dataset.mode}`, { method: 'POST', body: JSON.stringify({ username: values.username.trim(), password: values.password, displayName: values.displayName?.trim() }) });
      state.page = 'courses';
      state.filters = { courses: { search: '', status: '', category: '' }, records: { course: '', start: '', end: '' }, reminders: { status: '' }, plans: { level: 'weekly', category: '' } };
      state.notified.clear();
      state.recordPage = 1;
      await loadData();
      renderShell();
      toast(form.dataset.mode === 'register' ? '注册成功' : '登录成功');
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      submitButton.disabled = false;
      submitButton.textContent = previousText;
    }
  }

  async function loadData() {
    const [courses, records, reminders, stats, plans] = await Promise.all([api('/api/courses'), api('/api/records'), api('/api/reminders'), api('/api/stats'), api('/api/plans')]);
    Object.assign(state, { courses, records, reminders, stats, plans });
  }

  function renderShell() {
    app.innerHTML = `<header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">▤</span>学习计划与课程管理系统</div>
      <div class="account"><span class="account-name" title="${escapeHtml(state.user.displayName)}">${escapeHtml(state.user.displayName)}</span><button class="text-btn" data-action="logout">退出登录</button></div></header>
      <div class="app-layout"><nav class="sidebar" aria-label="主要导航"><div class="nav-label">学习管理</div>
      ${[['courses', '课程管理'], ['records', '学习记录与进度统计'], ['plans', '学习计划管理'], ['reminders', '学习提醒']].map(([key, name]) => `<button class="nav-button${state.page === key ? ' active' : ''}" data-action="navigate" data-page="${key}"${state.page === key ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${navIcon(key)}</span><span class="nav-text">${name}</span></button>`).join('')}
      </nav><main class="main"><div id="due-banner-area"></div><div id="page-content"></div></main></div>`;
    renderPage();
    initAiChat();
  }

  function pageHeader(title, description, actions = '') {
    return `<div class="page-header"><div><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}</div><div class="header-actions">${actions}</div></div>`;
  }

  function renderPage() {
    closeDatePicker(false);
    const container = document.getElementById('page-content');
    if (!container) return;
    const pages = { courses: coursesPage, records: recordsPage, reminders: remindersPage, plans: plansPage };
    if (!pages[state.page]) state.page = 'courses';
    container.innerHTML = pages[state.page]();
    document.querySelectorAll('.nav-button').forEach(button => {
      button.classList.toggle('active', button.dataset.page === state.page);
      if (button.dataset.page === state.page) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    bindFilters();
    updateDueBanner();
  }

  function recordsStatistics() {
    const stats = state.stats;
    const weekly = stats.weekly || [];
    const lastSevenMinutes = weekly.reduce((sum, day) => sum + number(day.minutes), 0);
    const progressCourses = stats.byCourse || [];
    return `<div class="stats-grid">
        <div class="stat-card"><div class="stat-label">累计学习</div><div class="stat-number">${number(stats.totalMinutes)}<span class="stat-unit">分钟</span></div><div class="stat-note">${durationText(stats.totalMinutes)}</div></div>
        <div class="stat-card"><div class="stat-label">本周学习</div><div class="stat-number">${number(stats.weekMinutes)}<span class="stat-unit">分钟</span></div><div class="stat-note">本周一至今天的学习时长</div></div>
        <div class="stat-card"><div class="stat-label">今日学习</div><div class="stat-number">${number(stats.todayMinutes)}<span class="stat-unit">分钟</span></div><div class="stat-note">连续学习 ${number(stats.streakDays)} 天</div></div>
        <div class="stat-card"><div class="stat-label">总体进度</div><div class="stat-number">${percent(stats.overallProgress)}<span class="stat-unit">%</span></div><div class="stat-note">已完成 ${number(stats.completedCourses)} / ${number(stats.courseCount)} 门课程</div></div>
      </div>
      <div class="statistics-grid"><section class="panel"><div class="panel-header"><h2>最近 7 天学习时长</h2><span class="muted hint">单位：分钟</span></div><div class="panel-body"><div class="chart" role="img" aria-label="${escapeHtml(weekly.map(day => `${day.date}学习${day.minutes}分钟`).join('，'))}">
        ${weeklyChart(weekly)}
      </div><div class="chart-summary"><span>7 天累计 ${lastSevenMinutes} 分钟</span><span>日均 ${Math.round(lastSevenMinutes / 7)} 分钟</span></div></div></section>
      <section class="panel"><div class="panel-header"><h2>各课程学习进度</h2><span class="muted hint">累计时长 / 目标时长</span></div><div class="panel-body course-progress-list">
      ${progressCourses.length ? progressCourses.map(course => `<div class="progress-item"><div class="progress-item-head"><span class="progress-course" title="${escapeHtml(course.name)}">${escapeHtml(course.name)}</span><span class="progress-detail">${number(course.minutes)} / ${number(course.targetMinutes)} 分钟 · ${percent(course.progress)}%</span></div><div class="progress-track" role="progressbar" aria-label="${escapeHtml(course.name)}学习进度" aria-valuenow="${percent(course.progress)}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${percent(course.progress)}%"></div></div></div>`).join('') : '<div class="small-empty">还没有课程，请添加课程。</div>'}
      </div></section></div>`;
  }

  function weeklyChart(days) {
    const max = Math.max(60, Math.ceil(Math.max(0, ...days.map(day => number(day.minutes))) / 60) * 60);
    const plotHeight = 142, baseline = 176, step = 462 / 7;
    return `<svg viewBox="0 0 520 216" class="weekly-chart" aria-hidden="true"><g font-family="Microsoft YaHei, Arial, sans-serif" font-size="12" fill="#536170">${[0, max / 2, max].map(value => {
      const y = baseline - value / max * plotHeight;
      return `<line x1="42" y1="${y}" x2="510" y2="${y}" stroke="#b9c3cd" stroke-width="1"/><text x="32" y="${y + 4}" text-anchor="end">${value}</text>`;
    }).join('')}<line x1="42" y1="34" x2="42" y2="176" stroke="#7d8e9e" stroke-width="1"/>${days.map((day, index) => {
      const minutes = number(day.minutes), height = minutes / max * plotHeight, x = 42 + step * (index + .5);
      return `<g><title>${escapeHtml(day.date)}：${minutes}分钟</title><rect x="${x - 15}" y="${baseline - height}" width="30" height="${height}" fill="${day.date === localDate() ? '#163f68' : '#567c9a'}"/><text x="${x}" y="${baseline - height - 7}" text-anchor="middle" fill="#263443">${minutes}</text><text x="${x}" y="202" text-anchor="middle">${escapeHtml(day.date.slice(5).replace('-', '/'))}</text></g>`;
    }).join('')}</g></svg>`;
  }

  function filteredCourses() {
    const filters = state.filters.courses;
    return state.courses.filter(course => {
      const haystack = `${course.name} ${course.category} ${course.teacher} ${course.description}`.toLowerCase();
      return (!filters.search || haystack.includes(filters.search.trim().toLowerCase())) && (!filters.status || course.status === filters.status) && (!filters.category || course.category === filters.category);
    });
  }

  function coursesPage() {
    const categories = [...new Set(state.courses.map(course => course.category))].filter(Boolean).sort();
    const filters = state.filters.courses;
    return pageHeader('课程管理', '', '<button class="primary-btn" data-action="open-course">＋ 添加课程</button>') +
      `<section class="panel"><div class="filters"><div class="filter-field"><label for="course-search">搜索课程</label><input class="filter-input" id="course-search" data-filter="courses.search" placeholder="课程名称、教师或学习内容" value="${escapeHtml(filters.search)}" maxlength="100"></div>
      <div class="filter-field"><label for="course-status">学习状态</label><select class="filter-select" id="course-status" data-filter="courses.status">${option('', '全部状态', filters.status)}${['未开始', '学习中', '已完成'].map(value => option(value, value, filters.status)).join('')}</select></div>
      <div class="filter-field"><label for="course-category">课程分类</label><select class="filter-select" id="course-category" data-filter="courses.category">${option('', '全部分类', filters.category)}${categories.map(value => option(value, value, filters.category)).join('')}</select></div>
      <button class="secondary-btn" data-action="reset-filters" data-kind="courses">重置</button><span id="course-count" class="filter-result"></span></div><div id="course-table"></div></section>`;
  }

  function renderCourseTable() {
    const courses = filteredCourses();
    document.getElementById('course-count').textContent = `共 ${courses.length} 门课程`;
    document.getElementById('course-table').innerHTML = courses.length ? `<div class="table-wrap"><table><thead><tr><th>课程信息</th><th>分类 / 教师</th><th>目标 / 截止日期</th><th>学习进度</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${courses.map(course => `<tr><td><span class="cell-title">${escapeHtml(course.name)}</span>${course.description ? `<div class="cell-subtitle">${escapeHtml(course.description)}</div>` : ''}</td><td class="nowrap">${escapeHtml(course.category || '其他')}<div class="cell-subtitle">${escapeHtml(course.teacher || '未填写教师')}</div></td><td class="nowrap">${durationText(course.targetMinutes)}<div class="cell-subtitle">${escapeHtml(course.deadline || '未设置截止日期')}</div></td><td><div class="table-progress"><div class="progress-detail">${number(course.completedMinutes)} 分钟 · ${percent(course.progress)}%</div><div class="progress-track" role="progressbar" aria-label="${escapeHtml(course.name)}学习进度" aria-valuenow="${percent(course.progress)}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${percent(course.progress)}%"></div></div></div></td><td>${statusTag(course.status)}</td><td class="cell-actions"><button class="text-btn" data-action="open-record" data-course-id="${number(course.id)}">记录学习</button><button class="text-btn" data-action="open-course" data-id="${number(course.id)}">编辑</button><button class="text-btn danger" data-action="delete-course" data-id="${number(course.id)}">删除</button></td></tr>`).join('')}
      </tbody></table></div>` : emptyState(state.courses.length ? '没有符合条件的课程' : '还没有添加课程', state.courses.length ? '调整搜索或筛选条件后再试。' : '添加课程名称和学习目标，开始安排学习。', state.courses.length ? '' : '<button class="primary-btn" data-action="open-course">添加第一门课程</button>');
  }

  function recordsPage() {
    const filters = state.filters.records;
    return pageHeader('学习记录与进度统计', '', '<button class="primary-btn" data-action="open-record">＋ 记录学习</button>') + recordsStatistics() +
      `<section class="panel records-panel"><div class="panel-header"><h2>学习记录明细</h2></div><div id="record-details"><div class="filters"><div class="filter-field course-filter"><label for="record-course">课程</label><select class="filter-select" id="record-course" data-filter="records.course">${courseOptions(filters.course)}</select></div>
      <div class="filter-field date-filter"><label for="record-start">开始日期</label>${dateControl('record-start', filters.start, { filter: 'records.start' })}</div>
      <div class="filter-field date-filter"><label for="record-end">结束日期</label>${dateControl('record-end', filters.end, { filter: 'records.end' })}</div>
      <button class="secondary-btn" data-action="reset-filters" data-kind="records">重置</button><span id="record-count" class="filter-result" role="status"></span></div><div id="record-table"></div></div></section>`;
  }

  function renderRecordTable() {
    const filters = state.filters.records;
    const records = state.records.filter(record => (!filters.course || String(record.courseId) === filters.course) && (!filters.start || record.date >= filters.start) && (!filters.end || record.date <= filters.end)).sort((a, b) => b.date.localeCompare(a.date) || number(b.id) - number(a.id));
    const minutes = records.reduce((sum, record) => sum + number(record.duration), 0);
    const totalPages = Math.max(1, Math.ceil(records.length / state.recordPageSize));
    state.recordPage = Math.max(1, Math.min(state.recordPage, totalPages));
    const visible = records.slice((state.recordPage - 1) * state.recordPageSize, state.recordPage * state.recordPageSize);
    document.getElementById('record-count').textContent = filters.start && filters.end && filters.start > filters.end ? '开始日期不能晚于结束日期' : `共 ${records.length} 条 · ${durationText(minutes)}`;
    document.getElementById('record-table').innerHTML = records.length ? `<div class="table-wrap"><table><thead><tr><th>学习日期</th><th>课程</th><th>学习时长</th><th>学习内容</th><th>操作</th></tr></thead><tbody>${visible.map(record => `<tr><td class="nowrap">${escapeHtml(record.date)}</td><td><span class="cell-title">${escapeHtml(record.courseName)}</span></td><td class="nowrap">${number(record.duration)} 分钟</td><td class="record-content">${escapeHtml(record.content || '—')}</td><td class="cell-actions"><button class="text-btn" data-action="open-record" data-id="${number(record.id)}">编辑</button><button class="text-btn danger" data-action="delete-record" data-id="${number(record.id)}">删除</button></td></tr>`).join('')}</tbody></table></div><nav class="pagination" aria-label="学习记录分页"><span>每页 ${state.recordPageSize} 条</span><div><button class="secondary-btn" data-action="record-page" data-page="${state.recordPage - 1}"${state.recordPage === 1 ? ' disabled' : ''}>上一页</button><span class="page-number" role="status">第 ${state.recordPage} / ${totalPages} 页</span><button class="secondary-btn" data-action="record-page" data-page="${state.recordPage + 1}"${state.recordPage === totalPages ? ' disabled' : ''}>下一页</button></div></nav>` : emptyState(state.records.length ? '没有符合条件的学习记录' : '还没有学习记录', state.records.length ? '调整课程或日期范围后再试。' : '选择课程，填写学习日期、时长和本次学习内容。', state.records.length ? '' : '<button class="primary-btn" data-action="open-record">记录一次学习</button>');
  }

  const planLevelLabel = level => ({ weekly: '每周计划', midterm: '中期计划', longterm: '长期计划' }[level] || '计划');
  const planLevelHint = level => ({ weekly: '本周内的任务与打卡安排', midterm: '约一个月内的章节复习、刷题与笔记目标', longterm: '本学期分数目标或完成一个项目' }[level] || '');

  function filteredPlans() {
    const filters = state.filters.plans;
    return state.plans.filter(plan => plan.level === filters.level && (!filters.category || plan.category === filters.category));
  }

  function plansPage() {
    const filters = state.filters.plans;
    const categories = [...new Set(state.plans.filter(plan => plan.level === filters.level).map(plan => plan.category))].filter(Boolean).sort();
    return pageHeader('学习计划管理', '明确目标、拆解任务，按时间线推进学习计划', '<button class="primary-btn" data-action="open-plan">＋ 新建计划</button>') +
      `<div class="plan-tabs" role="tablist" aria-label="计划层级">
        ${['weekly', 'midterm', 'longterm'].map(level => `<button class="plan-tab${filters.level === level ? ' active' : ''}" role="tab" aria-selected="${filters.level === level}" data-action="plan-level" data-level="${level}"><span class="plan-tab-title">${planLevelLabel(level)}</span><span class="plan-tab-hint">${planLevelHint(level)}</span></button>`).join('')}
      </div>
      <section class="panel"><div class="filters"><div class="filter-field"><label for="plan-category-filter">计划分类</label><select class="filter-select" id="plan-category-filter" data-filter="plans.category">${option('', '全部分类', filters.category)}${categories.map(value => option(value, value, filters.category)).join('')}</select></div><button class="secondary-btn" data-action="reset-filters" data-kind="plans">重置</button><span id="plan-count" class="filter-result"></span></div><div id="plan-list"></div></section>`;
  }

  function renderPlanList() {
    const expanded = [...expandedPlanIds];
    const plans = filteredPlans().sort((a, b) => (a.startDate || '').localeCompare(b.startDate || '') || number(b.id) - number(a.id));
    document.getElementById('plan-count').textContent = `共 ${plans.length} 个计划`;
    document.getElementById('plan-list').innerHTML = plans.length ? plans.map(plan => planCard(plan)).join('') : emptyState('还没有此类计划', '点击右上角“新建计划”，可以填写目标并由 AI 生成详细规划。', '<button class="primary-btn" data-action="open-plan">新建一个计划</button>');
    expanded.forEach(id => {
      const body = document.getElementById(`plan-body-${id}`);
      const button = document.querySelector(`.plan-toggle[data-id="${id}"]`);
      if (!body || !button) return;
      body.hidden = false; body.dataset.loaded = '1';
      button.setAttribute('aria-expanded', 'true');
      button.querySelector('.disclosure-arrow').textContent = '▾';
      renderPlanTasks(body, id);
    });
  }

  function planCard(plan) {
    const categoryLabel = plan.category || '其他';
    const statusClass = plan.status === '已完成' ? 'green' : plan.status === '已暂停' ? 'red' : 'blue';
    const dateRange = plan.startDate || plan.endDate ? `${plan.startDate || '未定'} ~ ${plan.endDate || '未定'}` : '时间未定';
    const progress = plan.taskCount ? Math.round(plan.completedCount / plan.taskCount * 100) : 0;
    return `<div class="plan-card" id="plan-card-${number(plan.id)}">
      <div class="plan-card-head">
        <button class="plan-toggle" data-action="toggle-plan" data-id="${number(plan.id)}" aria-expanded="false" aria-controls="plan-body-${number(plan.id)}"><span class="disclosure-arrow" aria-hidden="true">▸</span><span class="plan-title">${escapeHtml(plan.title)}</span><span class="tag ${statusClass}">${escapeHtml(plan.status)}</span></button>
        <div class="plan-card-actions"><button class="text-btn" data-action="open-plan" data-id="${number(plan.id)}">编辑</button><button class="text-btn danger" data-action="delete-plan" data-id="${number(plan.id)}">删除</button></div>
      </div>
      <div class="plan-card-meta"><span class="tag">${escapeHtml(categoryLabel)}</span><span class="muted">${escapeHtml(dateRange)}</span><span class="muted">${plan.taskCount} 项任务 · ${plan.completedCount} 项完成 · ${progress}%</span><div class="plan-progress" role="progressbar" aria-label="${escapeHtml(plan.title)}完成进度" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><div class="plan-progress-fill" style="width:${progress}%"></div></div><span class="plan-proof-hint">展开计划后可打卡并上传图片凭证</span></div>
      <div id="plan-body-${number(plan.id)}" class="plan-body" hidden>
        ${plan.goal ? `<div class="plan-goal"><strong>计划目标</strong><p>${escapeHtml(plan.goal)}</p></div>` : ''}
        ${plan.aiPlanning ? `<div class="plan-ai"><strong>AI 规划内容</strong><pre>${escapeHtml(plan.aiPlanning)}</pre></div>` : '<div class="small-empty">暂无 AI 规划内容，可编辑计划后点击“AI 生成规划”。</div>'}
        <div class="plan-tasks"><div class="plan-tasks-head"><strong>打卡任务</strong><button class="text-btn" data-action="open-plan-task" data-plan-id="${number(plan.id)}">＋ 添加任务</button></div>
        <div id="plan-tasks-${number(plan.id)}" class="plan-tasks-body"></div></div>
      </div>
    </div>`;
  }

  async function renderPlanTasks(planElement, planId) {
    const container = planElement.querySelector(`#plan-tasks-${planId}`);
    if (!container) return;
    let detail;
    try { detail = await api(`/api/plans/${planId}`); }
    catch (error) { container.innerHTML = `<div class="small-empty">${escapeHtml(error.message)}</div>`; return; }
    const tasks = detail.tasks || [];
    container.innerHTML = tasks.length ? `<div class="table-wrap plan-task-table"><table><thead><tr><th>事件/时间</th><th>科目</th><th>目标</th><th>打卡任务</th><th>图片凭证</th><th>操作</th></tr></thead><tbody>${tasks.map(task => planTaskRow(task, planId)).join('')}</tbody></table></div>` : '<div class="small-empty">还没有打卡任务，点击上方“添加任务”。</div>';
    container.querySelectorAll('[data-action="toggle-task-complete"]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); toggleTaskComplete(planId, button.dataset.id); }));
    container.querySelectorAll('[data-action="open-plan-task"]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); openPlanTask(planId, button.dataset.id); }));
    container.querySelectorAll('[data-action="delete-plan-task"]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); deletePlanTask(planId, button.dataset.id); }));
    container.querySelectorAll('[data-action="upload-proof"]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); uploadProof(planId, button.dataset.id); }));
  }

  function planTaskRow(task, planId) {
    const proof = task.proofImage
      ? `<a href="${escapeHtml(task.proofImage)}" target="_blank" rel="noopener"><img class="proof-thumb" src="${escapeHtml(task.proofImage)}" alt="打卡凭证"></a>`
      : '<span class="muted">未上传</span>';
    return `<tr class="${task.completed ? 'task-done' : ''}">
      <td class="nowrap">${escapeHtml(task.dueDate || '未设日期')}</td>
      <td><span class="cell-title">${escapeHtml(task.subject || '—')}</span></td>
      <td>${escapeHtml(task.goal || '—')}</td>
      <td class="nowrap"><button class="text-btn" data-action="toggle-task-complete" data-plan-id="${number(planId)}" data-id="${number(task.id)}" ${task.completed ? 'aria-pressed="true"' : ''}>${task.completed ? '✓ 已完成' : '去打勾'}</button></td>
      <td class="nowrap proof-cell">${proof}<button class="secondary-btn proof-upload-btn" data-action="upload-proof" data-plan-id="${number(planId)}" data-id="${number(task.id)}">${task.proofImage ? '更换图片' : '上传图片'}</button></td>
      <td class="cell-actions"><button class="text-btn" data-action="open-plan-task" data-plan-id="${number(planId)}" data-id="${number(task.id)}">编辑</button><button class="text-btn danger" data-action="delete-plan-task" data-plan-id="${number(planId)}" data-id="${number(task.id)}">删除</button></td>
    </tr>`;
  }

  function reminderStatus(reminder) {
    if (reminder.done) return '已完成';
    if (!reminder.enabled) return '已停用';
    if (reminder.readDueAt === reminder.dueAt) return '已读';
    return new Date(reminder.dueAt).getTime() <= Date.now() ? '已到时间' : '待提醒';
  }

  function notificationStatus() {
    if (!('Notification' in window)) return '当前浏览器不支持系统通知，页面内提醒仍可使用。';
    if (Notification.permission === 'denied') return '浏览器通知被禁用，可在浏览器的站点设置中允许通知。';
    if (Notification.permission === 'granted' && state.notificationEnabled) return '浏览器通知已开启。关闭页面后停止通知。';
    return '保持页面打开以接收提醒。';
  }

  function remindersPage() {
    const status = state.filters.reminders.status;
    return pageHeader('学习提醒', '', '<button class="primary-btn" data-action="open-reminder">＋ 添加提醒</button>') +
      `<div class="notice"><div><strong>通知设置</strong><p id="notification-status">${notificationStatus()}</p></div><button class="secondary-btn" data-action="notification">${state.notificationEnabled && 'Notification' in window && Notification.permission === 'granted' ? '关闭浏览器通知' : '开启浏览器通知'}</button></div>
      <section class="panel"><div class="filters"><div class="filter-field"><label for="reminder-status">提醒状态</label><select class="filter-select" id="reminder-status" data-filter="reminders.status">${option('', '全部状态', status)}${['待提醒', '已到时间', '已读', '已停用', '已完成'].map(value => option(value, value, status)).join('')}</select></div><button class="secondary-btn" data-action="reset-filters" data-kind="reminders">重置</button><span id="reminder-count" class="filter-result"></span></div><div id="reminder-table"></div></section>`;
  }

  function renderReminderTable() {
    const filter = state.filters.reminders.status;
    const reminders = state.reminders.filter(reminder => !filter || reminderStatus(reminder) === filter).sort((a, b) => Number(a.done) - Number(b.done) || new Date(a.dueAt) - new Date(b.dueAt));
    document.getElementById('reminder-count').textContent = `共 ${reminders.length} 条提醒`;
    document.getElementById('reminder-table').innerHTML = reminders.length ? `<div class="table-wrap"><table><thead><tr><th>提醒内容</th><th>提醒时间</th><th>重复频率</th><th>状态</th><th>操作</th></tr></thead><tbody>${reminders.map(reminder => {
      const status = reminderStatus(reminder);
      return `<tr><td><span class="cell-title">${escapeHtml(reminder.title)}</span><div class="cell-subtitle">${escapeHtml(reminder.courseName || '未关联课程')}</div></td><td class="nowrap">${escapeHtml(displayDateTime(reminder.dueAt))}</td><td class="nowrap">${repeatLabel(reminder.repeat)}</td><td><span class="tag ${['已完成', '已读'].includes(status) ? 'green' : status === '已到时间' ? 'red' : status === '待提醒' ? 'blue' : ''}">${status}</span></td><td class="cell-actions">${status === '已到时间' ? `<button class="text-btn" data-action="read-reminder" data-id="${number(reminder.id)}">已读</button>` : ''}${!reminder.done && reminder.enabled ? `<button class="text-btn" data-action="complete-reminder" data-id="${number(reminder.id)}">${reminder.repeat === 'none' ? '完成' : '完成本次'}</button>` : ''}${!reminder.done ? `<button class="text-btn" data-action="toggle-reminder" data-id="${number(reminder.id)}">${reminder.enabled ? '停用' : '启用'}</button>` : ''}<button class="text-btn" data-action="open-reminder" data-id="${number(reminder.id)}">编辑</button><button class="text-btn danger" data-action="delete-reminder" data-id="${number(reminder.id)}">删除</button></td></tr>`;
    }).join('')}</tbody></table></div>` : emptyState(state.reminders.length ? '没有符合条件的提醒' : '还没有学习提醒', state.reminders.length ? '选择其他提醒状态后再试。' : '安排一个学习时间，打开页面即可接收提醒。', state.reminders.length ? '' : '<button class="primary-btn" data-action="open-reminder">添加学习提醒</button>');
  }

  function emptyState(title, description, action = '') {
    return `<div class="empty-state"><h3>${title}</h3>${description ? `<p>${description}</p>` : ''}${action}</div>`;
  }

  function bindFilters() {
    const update = () => {
      if (state.page === 'courses') renderCourseTable();
      if (state.page === 'records') renderRecordTable();
      if (state.page === 'reminders') renderReminderTable();
      if (state.page === 'plans') renderPlanList();
    };
    document.querySelectorAll('[data-filter]').forEach(input => {
      input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
        const [kind, field] = input.dataset.filter.split('.');
        state.filters[kind][field] = input.value;
        if (kind === 'records') state.recordPage = 1;
        update();
      });
    });
    update();
  }

  function updateDueBanner() {
    const area = document.getElementById('due-banner-area');
    if (!area || !state.user) return;
    const due = dueReminders();
    area.innerHTML = due.length ? `<div class="due-banner" role="status"><span><strong>${due.length} 条学习提醒已到时间</strong>：${escapeHtml(due.slice(0, 2).map(reminder => reminder.title).join('；'))}${due.length > 2 ? '…' : ''}</span><div class="due-actions"><button class="text-btn" data-action="navigate" data-page="reminders">查看提醒</button><button class="secondary-btn" data-action="read-all-reminders">全部已读</button></div></div>` : '';
    if (state.notificationEnabled && 'Notification' in window && Notification.permission === 'granted') {
      due.forEach(reminder => {
        const key = `${reminder.id}:${reminder.dueAt}`;
        if (state.notified.has(key)) return;
        try {
          const notification = new Notification('学习提醒', { body: `${reminder.title}${reminder.courseName ? ` · ${reminder.courseName}` : ''}`, icon: '/favicon.svg', tag: key });
          notification.onclick = () => { window.focus(); state.page = 'reminders'; renderPage(); notification.close(); };
          state.notified.add(key);
        } catch (_) { /* 系统通知不可用时，保留页面内提醒。 */ }
      });
    }
  }

  function field(label, id, input, full = false, hint = '') {
    return `<div class="field${full ? ' full' : ''}"><label for="${id}">${label}</label>${input}${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;
  }

  async function openPlan(id = null) {
    const item = id ? state.plans.find(plan => String(plan.id) === String(id)) : null;
    if (id && !item) { toast('该计划已经不存在，请刷新后重试。', true); return; }
    const categories = [...new Set(state.courses.map(course => course.category))].filter(Boolean).sort();
    const levelDefault = item?.level || state.filters.plans.level || 'weekly';
    const categoryOptions = [...new Set(['专业必修', '专业选修', ...categories, item?.category].filter(Boolean))].sort();
    const fields = field('计划名称<span class="required">*</span>', 'plan-name', `<input id="plan-name" name="title" required maxlength="120" value="${escapeHtml(item?.title || '')}" placeholder="例如：数据结构期中复习">`, true) +
      field('计划层级<span class="required">*</span>', 'plan-level', `<select id="plan-level" name="level">${['weekly', 'midterm', 'longterm'].map(value => option(value, planLevelLabel(value), item?.level || levelDefault)).join('')}</select>`) +
      field('计划分类', 'plan-category', `<select id="plan-category" name="category">${option('', '请选择课程分类', item?.category || '')}${categoryOptions.map(value => option(value, value, item?.category || '')).join('')}</select>`, false, '分类沿用课程管理中已录入的课程分类') +
      field('开始日期', 'plan-start', dateControl('plan-start', item?.startDate || '', { name: 'startDate' })) +
      field('结束日期', 'plan-end', dateControl('plan-end', item?.endDate || '', { name: 'endDate' })) +
      field('计划目标', 'plan-goal', `<textarea id="plan-goal" name="goal" maxlength="1000" rows="3" placeholder="填写本计划想达成的目标，例如：本月复习完第 3 章、刷 50 道算法题">${escapeHtml(item?.goal || '')}</textarea>`, true) +
      field('计划状态', 'plan-status', `<select id="plan-status" name="status">${['进行中', '已完成', '已暂停'].map(value => option(value, value, item?.status || '进行中')).join('')}</select>`);
    formDialog.innerHTML = `<form id="edit-form" data-kind="plan" data-id="${item?.id || ''}"><div class="dialog-header"><h2 id="dialog-title">${item ? '编辑' : '新建'}计划</h2><button type="button" class="icon-btn" data-close-dialog aria-label="关闭">×</button></div><div class="dialog-body"><p id="edit-error" class="form-error" role="alert" hidden></p><div class="form-grid">${fields}</div>${item ? '' : '<div class="ai-box"><button type="button" class="secondary-btn" id="plan-ai-generate">✨ AI 生成规划</button><p class="hint">由 DeepSeek 大模型根据目标与课程分类生成，生成后可保存到计划。</p></div>'}</div><div class="dialog-footer"><button type="button" class="secondary-btn" data-close-dialog>取消</button><button type="submit" class="primary-btn">保存计划</button></div></form>`;
    document.getElementById('edit-form').addEventListener('submit', submitForm);
    formDialog.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => formDialog.close()));
    const aiButton = document.getElementById('plan-ai-generate');
    if (aiButton) aiButton.addEventListener('click', () => generatePlanAi());
    formDialog.showModal();
  }

  async function generatePlanAi() {
    const button = document.getElementById('plan-ai-generate');
    const errorBox = document.getElementById('edit-error');
    const title = document.getElementById('plan-name').value.trim();
    if (!title) { toast('请先填写计划名称', true); document.getElementById('plan-name').focus(); return; }
    button.disabled = true;
    button.textContent = '正在生成…';
    errorBox.hidden = true;
    try {
      const courses = state.courses.map(course => `${course.name}${course.category ? `（${course.category}）` : ''}`).filter(Boolean);
      const result = await api('/api/plans/ai', { method: 'POST', body: JSON.stringify({ level: document.getElementById('plan-level').value, title, category: document.getElementById('plan-category').value.trim(), goal: document.getElementById('plan-goal').value.trim(), startDate: document.getElementById('plan-start').value, endDate: document.getElementById('plan-end').value, courses }) });
      let goalField = document.getElementById('plan-goal');
      if (!goalField.value.trim() && result.aiPlanning) {
        // 不强制覆盖，仅提示
      }
      // 将 AI 规划内容存入隐藏字段
      let aiInput = document.getElementById('plan-ai-input');
      if (!aiInput) {
        aiInput = document.createElement('input');
        aiInput.type = 'hidden'; aiInput.id = 'plan-ai-input'; aiInput.name = 'aiPlanning';
        document.getElementById('edit-form').appendChild(aiInput);
      }
      aiInput.value = result.aiPlanning || '';
      // 预览展示
      let preview = document.getElementById('plan-ai-preview');
      if (!preview) {
        preview = document.createElement('div');
        preview.id = 'plan-ai-preview';
        preview.className = 'plan-ai-preview';
        document.querySelector('#edit-form .dialog-body').appendChild(preview);
      }
      preview.innerHTML = `<strong>AI 生成结果（预览）</strong><pre>${escapeHtml(result.aiPlanning || '')}</pre>`;
      toast('AI 规划已生成，可编辑或直接保存');
    } catch (error) {
      errorBox.textContent = `AI 生成失败：${error.message}`;
      errorBox.hidden = false;
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(`AI 生成失败：${error.message}`, true);
    }
    finally { button.disabled = false; button.textContent = '✨ AI 生成规划'; }
  }

  async function openPlanTask(planId, taskId = null) {
    let task = null;
    if (taskId) {
      const detail = await api(`/api/plans/${planId}`);
      task = detail.tasks.find(item => String(item.id) === String(taskId)) || null;
      if (!task) { toast('该任务已经不存在，请刷新后重试。', true); return; }
    }
    const fields = field('科目<span class="required">*</span>', 'task-subject', `<input id="task-subject" name="subject" required maxlength="80" value="${escapeHtml(task?.subject || '')}" placeholder="例如：数据结构">`, true) +
      field('任务目标', 'task-goal', `<textarea id="task-goal" name="goal" maxlength="1000" rows="3" placeholder="例如：完成二叉树章节并刷 10 道题">${escapeHtml(task?.goal || '')}</textarea>`, true) +
      field('打卡日期', 'task-due', dateControl('task-due', task?.dueDate || '', { name: 'dueDate' })) +
      field('备注', 'task-note', `<textarea id="task-note" name="note" maxlength="1000" rows="2" placeholder="备注（可选）">${escapeHtml(task?.note || '')}</textarea>`);
    formDialog.innerHTML = `<form id="edit-form" data-kind="plan-task" data-plan-id="${number(planId)}" data-id="${taskId || ''}"><div class="dialog-header"><h2 id="dialog-title">${task ? '编辑' : '添加'}打卡任务</h2><button type="button" class="icon-btn" data-close-dialog aria-label="关闭">×</button></div><div class="dialog-body"><p id="edit-error" class="form-error" role="alert" hidden></p><div class="form-grid">${fields}</div></div><div class="dialog-footer"><button type="button" class="secondary-btn" data-close-dialog>取消</button><button type="submit" class="primary-btn">保存任务</button></div></form>`;
    document.getElementById('edit-form').addEventListener('submit', submitForm);
    formDialog.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => formDialog.close()));
    formDialog.showModal();
  }

  async function toggleTaskComplete(planId, taskId) {
    state.busy = true;
    try {
      const detail = await api(`/api/plans/${planId}`);
      const task = detail.tasks.find(item => String(item.id) === String(taskId));
      if (!task) { toast('该任务已经不存在', true); return; }
      await api(`/api/plans/${planId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ subject: task.subject, goal: task.goal, dueDate: task.dueDate, completed: !task.completed, note: task.note, proofImage: task.proofImage }) });
      await loadData();
      await renderPlanList();
      const element = document.getElementById(`plan-card-${planId}`);
      if (element) await renderPlanTasks(element, planId);
      toast(task.completed ? '任务已标记为未完成' : '打卡成功');
    } catch (error) { toast(error.message, true); }
    finally { state.busy = false; }
  }

  async function deletePlanTask(planId, taskId) {
    const detail = await api(`/api/plans/${planId}`);
    const task = detail.tasks.find(item => String(item.id) === String(taskId));
    if (!task) return;
    if (!await confirmAction('删除任务', `确定删除“${task.subject || '该任务'}”吗？`, '删除', true)) return;
    state.busy = true;
    try { await api(`/api/plans/${planId}/tasks/${taskId}`, { method: 'DELETE' }); await loadData(); await renderPlanList(); toast('任务已删除'); }
    catch (error) { toast(error.message, true); }
    finally { state.busy = false; }
  }

  async function uploadProof(planId, taskId) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) { toast('图片不能超过 8MB', true); return; }
      state.busy = true;
      let proofImage;
      try {
        const detail = await api(`/api/plans/${planId}`);
        const task = detail.tasks.find(item => String(item.id) === String(taskId));
        const response = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file, credentials: 'same-origin' });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || '上传失败');
        proofImage = payload.data.url;
        await api(`/api/plans/${planId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ subject: task.subject, goal: task.goal, dueDate: task.dueDate, completed: task.completed, note: task.note, proofImage }) });
        toast('图片凭证已上传');
        await loadData();
        await renderPlanList();
        const element = document.getElementById(`plan-card-${planId}`);
        if (element) await renderPlanTasks(element, planId);
      } catch (error) { toast(error.message, true); }
      finally { state.busy = false; }
    };
    input.click();
  }

  function openForm(kind, id = null, courseId = '') {
    const collection = state[`${kind}s`];
    const item = id ? collection.find(value => String(value.id) === String(id)) : null;
    if (id && !item) { toast('该条数据已经不存在，请刷新后重试。', true); return; }
    if (kind === 'record' && !state.courses.length) {
      toast('请先添加一门课程，再记录学习。');
      state.page = 'courses';
      renderPage();
      openForm('course');
      return;
    }
    let fields = '';
    if (kind === 'course') {
      const courseCategories = [...new Set(['专业必修', '专业选修', '公共基础', '其他', ...state.courses.map(course => course.category), item?.category].filter(Boolean))].sort();
      fields = field('课程名称<span class="required">*</span>', 'form-name', `<input id="form-name" name="name" required maxlength="80" value="${escapeHtml(item?.name || '')}" placeholder="例如：数据结构">`, true) +
        field('课程分类', 'form-category', `<select id="form-category" name="category">${courseCategories.map(value => option(value, value, item?.category || '专业必修')).join('')}</select>`) +
        field('授课教师', 'form-teacher', `<input id="form-teacher" name="teacher" maxlength="40" value="${escapeHtml(item?.teacher || '')}" placeholder="可不填写">`) +
        field('目标学习时长（分钟）<span class="required">*</span>', 'form-target', `<input id="form-target" name="targetMinutes" type="number" required min="1" max="100000" step="1" value="${number(item?.targetMinutes) || 1200}">`, false, '用于自动计算课程进度。') +
        field('计划截止日期', 'form-deadline', dateControl('form-deadline', item?.deadline || '', { name: 'deadline' })) +
        field('课程说明 / 学习计划', 'form-description', `<textarea id="form-description" name="description" maxlength="1000" rows="3" placeholder="填写学习内容、章节安排或课程要求">${escapeHtml(item?.description || '')}</textarea>`, true);
    } else if (kind === 'record') {
      fields = field('学习课程<span class="required">*</span>', 'form-course', `<select id="form-course" name="courseId" required>${courseOptions(item?.courseId || courseId, '请选择课程')}</select>`, true) +
        field('学习日期<span class="required">*</span>', 'form-date', dateControl('form-date', item?.date || localDate(), { name: 'date', required: true, max: localDate() })) +
        field('学习时长（分钟）<span class="required">*</span>', 'form-duration', `<input id="form-duration" name="duration" type="number" required min="1" max="1440" step="1" value="${number(item?.duration) || 60}">`) +
        field('本次学习内容', 'form-content', `<textarea id="form-content" name="content" maxlength="1000" rows="4" placeholder="例如：完成二叉树章节，练习前序与中序遍历">${escapeHtml(item?.content || '')}</textarea>`, true, '保存后，学习时长会计入课程进度和统计。');
    } else {
      fields = field('提醒内容<span class="required">*</span>', 'form-title', `<input id="form-title" name="title" required maxlength="100" value="${escapeHtml(item?.title || '')}" placeholder="例如：复习数据结构第三章">`, true) +
        field('关联课程', 'form-course', `<select id="form-course" name="courseId">${courseOptions(item?.courseId || '', '不关联课程')}</select>`, true) +
        field('提醒时间<span class="required">*</span>', 'form-due', `<input id="form-due" name="dueAt" type="datetime-local" required value="${escapeHtml(localDateTime(item?.dueAt))}">`) +
        field('重复频率', 'form-repeat', `<select id="form-repeat" name="repeat">${['none', 'daily', 'weekly'].map(value => option(value, repeatLabel(value), item?.repeat || 'none')).join('')}</select>`) +
        `<div class="field full"><label class="checkbox-label" for="form-enabled"><input id="form-enabled" name="enabled" type="checkbox"${item?.enabled !== false ? ' checked' : ''}>启用此提醒</label><p class="hint">已读后关闭本次提示；重复提醒自动安排下一次。${item?.done ? '保存后，这条已完成提醒会重新启用。' : ''}</p></div>`;
    }
    const name = { course: '课程', record: '学习记录', reminder: '学习提醒' }[kind];
    formDialog.innerHTML = `<form id="edit-form" data-kind="${kind}" data-id="${item?.id || ''}"><div class="dialog-header"><h2 id="dialog-title">${item ? '编辑' : '添加'}${name}</h2><button type="button" class="icon-btn" data-close-dialog aria-label="关闭">×</button></div><div class="dialog-body"><p id="edit-error" class="form-error" role="alert" hidden></p><div class="form-grid">${fields}</div></div><div class="dialog-footer"><button type="button" class="secondary-btn" data-close-dialog>取消</button><button type="submit" class="primary-btn">保存${name}</button></div></form>`;
    document.getElementById('edit-form').addEventListener('submit', submitForm);
    formDialog.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => formDialog.close()));
    formDialog.showModal();
  }

  async function submitForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const kind = form.dataset.kind, id = form.dataset.id;
    const values = Object.fromEntries(new FormData(form));
    const errorBox = document.getElementById('edit-error');
    const submitButton = form.querySelector('[type="submit"]');
    let payload;
    if (kind === 'course') payload = { ...values, name: values.name.trim(), category: values.category.trim(), teacher: values.teacher.trim(), description: values.description.trim(), targetMinutes: Number(values.targetMinutes), deadline: values.deadline || null };
    if (kind === 'record') payload = { ...values, courseId: Number(values.courseId), duration: Number(values.duration), content: values.content.trim() };
    if (kind === 'reminder') payload = { ...values, title: values.title.trim(), courseId: values.courseId ? Number(values.courseId) : null, dueAt: new Date(values.dueAt).toISOString(), enabled: form.elements.enabled.checked };
    if (kind === 'plan') payload = { ...values, title: values.title.trim(), category: values.category.trim(), goal: values.goal.trim(), startDate: values.startDate || null, endDate: values.endDate || null, aiPlanning: values.aiPlanning || '', level: values.level, status: values.status };
    if (kind === 'plan-task') payload = { subject: values.subject.trim(), goal: values.goal.trim(), dueDate: values.dueDate || null, completed: false, note: values.note.trim(), proofImage: values.proofImage || null };
    errorBox.hidden = true;
    const previousText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = '正在保存…';
    formDialog.querySelectorAll('[data-close-dialog]').forEach(button => { button.disabled = true; });
    state.busy = true;
    try {
      let path;
      if (kind === 'plan') path = `/api/plans${id ? `/${id}` : ''}`;
      else if (kind === 'plan-task') path = `/api/plans/${form.dataset.planId}/tasks${id ? `/${id}` : ''}`;
      else path = `/api/${kind}s${id ? `/${id}` : ''}`;
      await api(path, { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      await loadData();
      formDialog.close();
      renderPage();
      toast('保存成功');
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      submitButton.disabled = false;
      submitButton.textContent = previousText;
      formDialog.querySelectorAll('[data-close-dialog]').forEach(button => { button.disabled = false; });
    } finally { state.busy = false; }
  }

  function confirmAction(title, message, buttonText = '确认删除', danger = true) {
    return new Promise(resolve => {
      confirmDialog.innerHTML = `<div class="dialog-header"><h2 id="confirm-title">${escapeHtml(title)}</h2><button class="icon-btn" id="confirm-close" aria-label="关闭">×</button></div><p class="confirm-body">${escapeHtml(message)}</p><div class="dialog-footer"><button class="secondary-btn" id="confirm-cancel">取消</button><button class="${danger ? 'danger-btn' : 'primary-btn'}" id="confirm-ok">${buttonText}</button></div>`;
      let result = false;
      const onClose = () => { confirmDialog.removeEventListener('close', onClose); resolve(result); };
      confirmDialog.addEventListener('close', onClose);
      document.getElementById('confirm-ok').onclick = () => { result = true; confirmDialog.close(); };
      document.getElementById('confirm-cancel').onclick = document.getElementById('confirm-close').onclick = () => confirmDialog.close();
      confirmDialog.showModal();
    });
  }

  async function deleteItem(kind, id) {
    const item = state[`${kind}s`].find(value => String(value.id) === String(id));
    if (!item) return;
    const title = { course: '删除课程', record: '删除学习记录', reminder: '删除学习提醒', plan: '删除计划' }[kind];
    let message;
    if (kind === 'course') {
      const records = state.records.filter(record => record.courseId === item.id).length;
      const reminders = state.reminders.filter(reminder => reminder.courseId === item.id).length;
      message = `确定删除“${item.name}”吗？该课程的 ${records} 条学习记录和 ${reminders} 条关联提醒也会被删除，统计数据将重新计算。此操作无法撤销。`;
    } else if (kind === 'record') message = `确定删除 ${item.date} 的“${item.courseName}”学习记录吗？课程进度和统计将扣除这 ${item.duration} 分钟。`;
    else if (kind === 'plan') message = `确定删除“${item.title}”吗？该计划下的所有打卡任务也会一并删除。此操作无法撤销。`;
    else message = `确定删除“${item.title}”吗？这条提醒将不再出现。`;
    if (!await confirmAction(title, message)) return;
    await mutation(`/api/${kind}s/${id}`, { method: 'DELETE' }, '删除成功');
  }

  async function mutation(path, options, message) {
    state.busy = true;
    try { await api(path, options); await loadData(); renderPage(); toast(message); }
    catch (error) { toast(error.message, true); }
    finally { state.busy = false; }
  }

  async function toggleNotification() {
    if (!('Notification' in window)) { toast('当前浏览器不支持系统通知，页面内提醒仍可使用。'); return; }
    if (state.notificationEnabled && Notification.permission === 'granted') {
      state.notificationEnabled = false;
      try { localStorage.setItem('learning-notifications', 'off'); } catch (_) { /* 忽略偏好存储限制。 */ }
      toast('浏览器通知已关闭，页面内提醒继续显示。');
    } else {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast(permission === 'denied' ? '通知权限未允许，请在浏览器站点设置中开启。' : '未开启浏览器通知，页面内提醒仍可使用。');
      } else {
        state.notificationEnabled = true;
        state.notified.clear();
        try { localStorage.setItem('learning-notifications', 'on'); } catch (_) { /* 忽略偏好存储限制。 */ }
        toast('浏览器通知已开启');
      }
    }
    renderPage();
  }

  app.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled || state.busy) return;
    const { action, id } = button.dataset;
    if (action === 'auth-tab') { authPage(button.dataset.tab); return; }
    if (action === 'navigate') { state.page = button.dataset.page; renderPage(); return; }
    if (action === 'record-page') { state.recordPage = number(button.dataset.page); renderRecordTable(); return; }
    if (action === 'plan-level') { state.filters.plans.level = button.dataset.level; renderPage(); return; }
    if (action === 'toggle-plan') {
      const body = document.getElementById(`plan-body-${button.dataset.id}`);
      if (body) {
        const expanded = body.hidden;
        body.hidden = !expanded;
        if (expanded) expandedPlanIds.add(button.dataset.id); else expandedPlanIds.delete(button.dataset.id);
        button.setAttribute('aria-expanded', expanded);
        button.querySelector('.disclosure-arrow').textContent = expanded ? '▾' : '▸';
        if (expanded && !body.dataset.loaded) { body.dataset.loaded = '1'; renderPlanTasks(body, button.dataset.id); }
      }
      return;
    }
    if (action === 'open-plan') { openPlan(id); return; }
    if (action === 'open-plan-task') { openPlanTask(button.dataset.planId, id); return; }
    if (action === 'delete-plan-task') { deletePlanTask(button.dataset.planId, id); return; }
    if (action === 'toggle-task-complete') { toggleTaskComplete(button.dataset.planId, id); return; }
    if (action === 'upload-proof') { uploadProof(button.dataset.planId, id); return; }
    if (action.startsWith('open-')) {
      if (action === 'open-record' && state.page !== 'records') { state.page = 'records'; renderPage(); }
      openForm(action.slice(5), id, button.dataset.courseId);
      return;
    }
    if (action === 'reset-filters') {
      const kind = button.dataset.kind;
      const activePlanLevel = state.filters.plans.level;
      if (kind === 'records') state.recordPage = 1;
      Object.keys(state.filters[kind]).forEach(key => { state.filters[kind][key] = ''; });
      if (kind === 'plans') state.filters.plans.level = activePlanLevel || 'weekly';
      renderPage(); return;
    }
    if (action.startsWith('delete-')) { await deleteItem(action.slice(7), id); return; }
    if (action === 'logout') {
      if (!await confirmAction('退出登录', '确定退出当前账户吗？已保存的学习数据会保留。', '退出登录', false)) return;
      try { await api('/api/auth/logout', { method: 'POST' }); state.notified.clear(); authPage(); toast('已退出登录'); }
      catch (error) { toast(error.message, true); }
      return;
    }
    if (action === 'read-reminder' || action === 'read-all-reminders') {
      const reminders = dueReminders().filter(item => action === 'read-all-reminders' || String(item.id) === id);
      if (!reminders.length) return;
      button.disabled = true;
      state.busy = true;
      try {
        // Send the displayed occurrence so a stale tab cannot acknowledge the next reminder.
        await api('/api/reminders/read', { method: 'POST', body: JSON.stringify({ items: reminders.map(item => ({ id: item.id, dueAt: item.dueAt })) }) });
        await loadData();
        renderPage();
        toast(action === 'read-all-reminders' ? '到期提醒已全部标记为已读' : '提醒已读');
      } catch (error) { toast(error.message, true); }
      finally { state.busy = false; if (button.isConnected) button.disabled = false; }
      return;
    }
    if (action === 'complete-reminder') {
      const reminder = state.reminders.find(item => String(item.id) === id);
      button.disabled = true;
      await mutation(`/api/reminders/${id}/complete`, { method: 'POST' }, reminder?.repeat === 'none' ? '提醒已完成' : '本次提醒已完成，已安排下一次提醒');
      if (button.isConnected) button.disabled = false;
      return;
    }
    if (action === 'toggle-reminder') {
      const reminder = state.reminders.find(item => String(item.id) === id);
      if (!reminder) return;
      button.disabled = true;
      await mutation(`/api/reminders/${id}`, { method: 'PUT', body: JSON.stringify({ courseId: reminder.courseId, title: reminder.title, dueAt: reminder.dueAt, repeat: reminder.repeat, enabled: !reminder.enabled }) }, reminder.enabled ? '提醒已停用' : '提醒已启用');
      if (button.isConnected) button.disabled = false;
      return;
    }
    if (action === 'notification') await toggleNotification();
    if (action === 'retry') await init();
  });

  formDialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
  formDialog.addEventListener('close', () => closeDatePicker(false));

  async function pollReminders() {
    if (!state.user || state.polling || state.busy) return;
    state.polling = true;
    try {
      state.reminders = await api('/api/reminders');
      updateDueBanner();
      if (state.page === 'reminders' && !formDialog.open && !confirmDialog.open) renderReminderTable();
    } catch (error) {
      if (error.status === 401 && !formDialog.open && !confirmDialog.open) { authPage(); toast('登录已过期，请重新登录。'); }
    } finally { state.polling = false; }
  }

  function initAiChat() {
    if (document.getElementById('ai-chat-widget')) return;
    const messages = [];
    const widget = document.createElement('section');
    widget.id = 'ai-chat-widget';
    widget.className = 'ai-chat-widget';
    widget.innerHTML = `<button class="ai-chat-fab" type="button" aria-label="打开 AI 学习规划助手">🤖</button><div class="ai-chat-panel" hidden><div class="ai-chat-head"><strong>AI 学习规划助手</strong><div><button class="ai-chat-clear" type="button">清空</button><button class="ai-chat-close" type="button" aria-label="收起">×</button></div></div><div class="ai-chat-messages"><div class="ai-chat-welcome">你好！我可以帮你拆解计算机课程、制定复习路线、分析算法题或调整学习计划。</div></div><form class="ai-chat-form"><textarea rows="2" maxlength="2000" placeholder="例如：我有两周时间，如何复习数据结构？"></textarea><button class="primary-btn" type="submit">发送</button></form></div>`;
    document.body.append(widget);
    const fab = widget.querySelector('.ai-chat-fab'), panel = widget.querySelector('.ai-chat-panel');
    const list = widget.querySelector('.ai-chat-messages'), form = widget.querySelector('.ai-chat-form'), input = form.querySelector('textarea');
    const render = () => { list.innerHTML = messages.length ? messages.map(item => `<div class="ai-chat-message ${item.role === 'user' ? 'user' : 'assistant'}">${escapeHtml(item.content).replace(/\n/g, '<br>')}</div>`).join('') : '<div class="ai-chat-welcome">你好！我可以帮你拆解计算机课程、制定复习路线、分析算法题或调整学习计划。</div>'; list.scrollTop = list.scrollHeight; };
    fab.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) input.focus(); });
    widget.querySelector('.ai-chat-close').addEventListener('click', () => { panel.hidden = true; });
    widget.querySelector('.ai-chat-clear').addEventListener('click', () => { messages.length = 0; render(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const content = input.value.trim(); if (!content || form.dataset.busy) return;
      messages.push({ role: 'user', content }); input.value = ''; render(); form.dataset.busy = '1'; form.querySelector('button').disabled = true;
      const pending = document.createElement('div'); pending.className = 'ai-chat-message assistant'; pending.textContent = '正在思考…'; list.append(pending); list.scrollTop = list.scrollHeight;
      try { const result = await api('/api/ai/chat', { method: 'POST', body: JSON.stringify({ messages }) }); messages.push({ role: 'assistant', content: result.content }); render(); }
      catch (error) { pending.textContent = `生成失败：${error.message}`; pending.classList.add('error'); }
      finally { delete form.dataset.busy; form.querySelector('button').disabled = false; input.focus(); }
    });
    let dragging = false, offsetX = 0, offsetY = 0;
    fab.addEventListener('pointerdown', event => { dragging = true; const rect = widget.getBoundingClientRect(); offsetX = event.clientX - rect.left; offsetY = event.clientY - rect.top; fab.setPointerCapture(event.pointerId); });
    fab.addEventListener('pointermove', event => { if (!dragging) return; const x = Math.max(8, Math.min(innerWidth - widget.offsetWidth - 8, event.clientX - offsetX)); const y = Math.max(8, Math.min(innerHeight - widget.offsetHeight - 8, event.clientY - offsetY)); widget.style.left = `${x}px`; widget.style.top = `${y}px`; widget.style.right = 'auto'; widget.style.bottom = 'auto'; });
    fab.addEventListener('pointerup', () => { dragging = false; });
  }

  async function init() {
    app.innerHTML = '<div class="initial-loading">正在加载学习计划与课程管理系统…</div>';
    try {
      state.user = await api('/api/auth/me');
      await loadData();
      renderShell();
      initAiChat();
    } catch (error) {
      if (error.status === 401) authPage();
      else {
        app.innerHTML = `<div class="auth-page"><header class="auth-header"><div class="brand"><span class="brand-mark" aria-hidden="true">▤</span>学习计划与课程管理系统</div></header><main class="auth-main"><div class="auth-card"><h1>暂时无法打开</h1><p class="muted" style="margin:16px 0 22px">${escapeHtml(error.message)}</p><button class="primary-btn" data-action="retry">重新连接</button></div></main></div>`;
      }
    }
  }

  setInterval(pollReminders, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollReminders(); });
  init();
})();
