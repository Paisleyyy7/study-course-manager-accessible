/* Accessibility-only enhancement. No API, data, validation or business rules. */
(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const set = (node, name, value) => {
    if (node && node.getAttribute(name) !== String(value)) node.setAttribute(name, value);
  };
  const text = node => node?.textContent.trim().replace(/\s+/g, ' ') || '';
  const visible = node => node?.isConnected && !node.closest('[hidden]') && node.getClientRects().length && !node.disabled;
  const focus = node => { if (visible(node)) { node.focus({ preventScroll: false }); return true; } return false; };
  const status = document.createElement('div');
  status.id = 'a11y-announcements'; status.className = 'a11y-sr-only';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true'); document.body.append(status);
  let announceTimer;
  function announce(message) {
    if (!message) return;
    const output = $('dialog[open] .a11y-dialog-status') || status;
    clearTimeout(announceTimer); output.textContent = '';
    announceTimer = setTimeout(() => { if (output.isConnected) output.textContent = message; }, 80);
  }
  const skip = document.createElement('a');
  skip.className = 'a11y-skip'; skip.href = '#a11y-main'; skip.textContent = '跳到主要内容';
  document.body.prepend(skip);
  skip.addEventListener('click', event => { event.preventDefault(); focus($('main')); });
  const help = document.createElement('span'); help.className = 'a11y-sr-only';
  help.id = 'a11y-chat-help';
  help.textContent = '按回车打开助手，按 Escape 收起。聚焦悬浮按钮时可按 Alt 加方向键移动位置。';
  help.hidden = true; document.body.append(help);

  function identity(node) {
    if (!node || node === document.body) return null;
    if (node.dataset.action === 'record-page') return { pagination: text(node) };
    if (node.id) return { id: node.id };
    if (node.dataset.action) {
      const attrs = ['action', 'id', 'planId', 'courseId', 'page', 'level', 'kind'];
      return { data: Object.fromEntries(attrs.filter(key => key in node.dataset).map(key => [key, node.dataset[key]])) };
    }
    if (node.matches('.calendar-day')) return { date: node.dataset.date };
    if (node.dataset.calendarAction) return { calendarAction: node.dataset.calendarAction, offset: node.dataset.offset };
    const cls = ['calendar-year', 'calendar-month', 'ai-chat-fab', 'ai-chat-close', 'ai-chat-clear'];
    return cls.find(value => node.classList.contains(value)) ? { cls: cls.find(value => node.classList.contains(value)) } : null;
  }
  function locate(key) {
    if (!key) return null;
    if (key.pagination) return all('[data-action="record-page"]').find(node => text(node) === key.pagination && !node.disabled) || $('[data-action="record-page"]:not(:disabled)');
    if (key.id) return document.getElementById(key.id);
    if (key.cls) return $('.' + key.cls);
    if (key.data) return all('[data-action]').find(node => Object.entries(key.data).every(([k, v]) => node.dataset[k] === v));
    if (key.date) return all('.calendar-day').find(node => node.dataset.date === key.date);
    return all('[data-calendar-action]').find(node => node.dataset.calendarAction === key.calendarAction && node.dataset.offset === key.offset);
  }
  let lastFocus = null, lastKey = null, lastPlan = null, temporarilyDisabled = null;
  const openers = new Map();
  let clickOrigin = null;
  document.addEventListener('focusin', event => {
    lastFocus = event.target; lastKey = identity(lastFocus);
    lastPlan = lastFocus.closest('.plan-card')?.id || null;
  }, true);
  document.addEventListener('click', event => {
    const control = event.target.closest('button,a,input,select,textarea');
    if (control) clickOrigin = { node: control, key: identity(control), plan: control.closest('.plan-card')?.id };
  }, true);

  function heading() { return $('dialog[open] h2') || $('main h1') || $('main'); }
  function fallback(key, plan) {
    const same = locate(key);
    if (focus(same)) return;
    if (plan && focus(document.getElementById(plan)?.querySelector('.plan-toggle'))) return;
    focus(heading());
  }
  all('dialog').forEach(dialog => {
    dialog.addEventListener('close', () => {
      const origin = openers.get(dialog);
      requestAnimationFrame(() => {
        if ($('dialog[open]')) return;
        if (!focus(origin?.node)) fallback(origin?.key, origin?.plan);
      });
    });
  });
  const opened = new Set();
  let previousPage = '', previousReply = '', previousDue = '', previousGeneration = '', chatWasOpen = false;
  let serial = 0;

  function enhance() {
    const main = $('main');
    set(main, 'id', 'a11y-main'); set(main, 'tabindex', '-1');
    all('main h1, dialog h2').forEach(node => set(node, 'tabindex', '-1'));
    const title = text($('main h1'));
    if (title && previousPage !== title) {
      const wasPage = previousPage; previousPage = title;
      document.title = `${title} - 学习计划与课程管理系统`;
      if (wasPage && !$('dialog[open]')) focus($('main h1'));
    }
    all('input,select,textarea').forEach(input => {
      const field = input.closest('.field,.filter-field');
      const hint = field?.querySelector('.hint');
      if (hint) {
        if (!hint.id) hint.id = 'a11y-hint-' + (++serial);
        set(input, 'aria-describedby', hint.id);
      }
      if (input.dataset.dateRequired) set(input, 'aria-required', 'true');
      if (input.matches('input[data-calendar-action="open"]')) {
        set(input, 'role', 'combobox'); set(input, 'aria-autocomplete', 'none');
        set(input, 'aria-description', '只读日期输入框，按回车、空格或向下键打开日历，按方向键选择日期，按 Escape 关闭。');
        const trigger = input.parentElement.querySelector('.calendar-trigger');
        set(trigger, 'aria-haspopup', 'dialog'); set(trigger, 'aria-expanded', input.getAttribute('aria-expanded') || 'false');
        if ($('#date-picker') && input.getAttribute('aria-expanded') === 'true') {
          set(input, 'aria-controls', 'date-picker'); set(trigger, 'aria-controls', 'date-picker');
        } else { input.removeAttribute('aria-controls'); trigger?.removeAttribute('aria-controls'); }
      }
    });
    all('form').forEach(form => {
      const error = form.querySelector('.form-error');
      if (error) set(form, 'aria-describedby', error.id);
      set(form, 'aria-busy', form.dataset.busy ? 'true' : 'false');
    });
    all('table').forEach(table => {
      const pageNames = { 'course-table': '课程列表', 'record-table': '学习记录明细', 'reminder-table': '学习提醒列表' };
      const owner = table.closest('#course-table,#record-table,#reminder-table');
      set(table, 'aria-label', pageNames[owner?.id] || '计划打卡任务');
      all('thead th', table).forEach(th => set(th, 'scope', 'col'));
    });
    all('.table-wrap,.course-progress-list,.ai-chat-messages,.plan-ai pre').forEach(region => {
      if (region.scrollHeight > region.clientHeight + 1 || region.scrollWidth > region.clientWidth + 1) {
        set(region, 'tabindex', '0'); set(region, 'role', 'region');
        set(region, 'aria-label', text(region.closest('.panel')?.querySelector('h2')) || (region.matches('.ai-chat-messages') ? '对话记录' : '可滚动内容'));
      }
    });
    all('tbody tr').forEach(row => {
      const context = text(row.querySelector('.cell-title')) || text(row.cells[0]);
      all('button[data-action]', row).forEach(button => {
        const extra = button.dataset.planId ? text(row.cells[2]) : '';
        set(button, 'aria-label', `${text(button)}：${context}${extra ? '，' + extra : ''}`);
        if (button.dataset.action === 'toggle-task-complete') set(button, 'aria-pressed', row.classList.contains('task-done'));
      });
      all('.proof-thumb', row).forEach(img => {
        // Adapt the displayed local resource URL to the unchanged current-user endpoint.
        // Stored proofImage values and upload requests are left intact.
        const original = img.getAttribute('src');
        const resource = original?.match(/^\/api\/uploads\/\d+\/([^/]+)$/);
        if (resource) {
          set(img, 'src', '/api/uploads/' + resource[1]);
          set(img.closest('a'), 'href', '/api/uploads/' + resource[1]);
        }
        set(img, 'alt', `${context}的打卡凭证`);
        set(img.closest('a'), 'aria-label', `查看${context}的打卡凭证`);
        set(img.closest('a'), 'aria-haspopup', 'dialog');
      });
    });
    all('.plan-card').forEach(card => {
      const name = text(card.querySelector('.plan-title'));
      all('.plan-card-actions button', card).forEach(button => set(button, 'aria-label', `${text(button)}：${name}`));
      const toggle = card.querySelector('.plan-toggle');
      const body = card.querySelector('.plan-body');
      if (toggle && body) {
        set(toggle, 'id', 'a11y-toggle-' + card.id);
        set(body, 'role', 'region'); set(body, 'aria-labelledby', toggle.id);
      }
    });
    const tabs = all('.plan-tab');
    tabs.forEach(tab => {
      set(tab, 'id', 'a11y-tab-' + tab.dataset.level);
      set(tab, 'tabindex', tab.getAttribute('aria-selected') === 'true' ? '0' : '-1');
      set(tab, 'aria-controls', 'a11y-plan-panel');
    });
    const planPanel = $('#plan-list')?.closest('section');
    if (planPanel) {
      set(planPanel, 'id', 'a11y-plan-panel'); set(planPanel, 'role', 'tabpanel');
      set(planPanel, 'aria-labelledby', tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.id || '');
    }
    all('.filter-result,.pagination-info').forEach(node => { set(node, 'role', 'status'); set(node, 'aria-atomic', 'true'); });
    all('dialog').forEach(dialog => {
      if (dialog.open && !opened.has(dialog)) {
        opened.add(dialog); openers.set(dialog, clickOrigin || { node: lastFocus, key: lastKey, plan: lastPlan });
        const localStatus = document.createElement('div');
        localStatus.className = 'a11y-sr-only a11y-dialog-status';
        localStatus.setAttribute('role', 'status'); localStatus.setAttribute('aria-live', 'polite'); localStatus.setAttribute('aria-atomic', 'true');
        dialog.append(localStatus);
        const description = dialog.querySelector('.confirm-body');
        if (description) { set(description, 'id', 'a11y-confirm-description'); set(dialog, 'aria-describedby', description.id); }
        focus(dialog.querySelector('#confirm-cancel') || dialog.querySelector('input:not([type="hidden"]),select,textarea') || dialog.querySelector('h2'));
      } else if (!dialog.open) opened.delete(dialog);
    });
    const generate = $('#plan-ai-generate');
    const generation = generate ? (generate.disabled ? '正在生成学习规划，请稍候。' : text($('#plan-ai-preview')) ? '学习规划已生成，可在弹窗内查看预览并保存。' : '') : '';
    if (generation !== previousGeneration) { previousGeneration = generation; if (generation) announce(generation); }
    const picker = $('#date-picker');
    if (picker) {
      const days = all('.calendar-day:not(:disabled)', picker);
      const activeDay = days.includes(document.activeElement) ? document.activeElement : days.find(day => day.classList.contains('selected')) || days[0];
      all('.calendar-day', picker).forEach(day => {
        set(day, 'tabindex', day === activeDay ? '0' : '-1');
        set(day, 'aria-pressed', day.classList.contains('selected'));
        if (day.classList.contains('today')) set(day, 'aria-current', 'date');
      });
      set(picker, 'aria-label', `选择日期，${$('.calendar-year', picker)?.selectedOptions[0]?.textContent || ''}${$('.calendar-month', picker)?.selectedOptions[0]?.textContent || ''}`);
    }
    const panel = $('.ai-chat-panel'), fab = $('.ai-chat-fab');
    if (panel) {
      const widget = $('#ai-chat-widget');
      set(widget, 'role', 'complementary'); set(widget, 'aria-label', 'AI 学习规划助手');
      if (help.parentElement !== widget) widget.append(help);
      if (help.hidden) help.hidden = false;
      const isOpen = !panel.hidden;
      set(panel, 'id', 'a11y-chat-panel'); set(panel, 'role', 'region'); set(panel, 'aria-label', 'AI 学习规划助手');
      set(fab, 'aria-controls', panel.id); set(fab, 'aria-expanded', isOpen); set(fab, 'aria-describedby', help.id);
      set(fab, 'aria-label', isOpen ? '收起 AI 学习规划助手' : '打开 AI 学习规划助手');
      const input = panel.querySelector('textarea');
      set(input, 'id', 'a11y-chat-input'); set(input, 'aria-label', '发送给 AI 学习规划助手的消息');
      set($('.ai-chat-messages'), 'role', 'region'); set($('.ai-chat-messages'), 'aria-label', '对话记录');
      const last = all('.ai-chat-message.assistant').at(-1);
      if (isOpen && text(last) && text(last) !== previousReply) { previousReply = text(last); announce('AI 助手：' + previousReply); }
      if (chatWasOpen && !isOpen && panel.contains(document.activeElement)) focus(fab);
      chatWasOpen = isOpen;
    }
    const due = $('.due-banner');
    // Existing polling replaces this banner every 30 seconds. Announce only changes.
    if (due) { due.removeAttribute('role'); due.removeAttribute('aria-live'); }
    const dueText = text(due?.querySelector('span'));
    if (dueText !== previousDue) { previousDue = dueText; if (dueText) announce(dueText); }
    if (lastFocus && (!lastFocus.isConnected || lastFocus.closest('[hidden]')) && (!document.activeElement || document.activeElement === document.body)) fallback(lastKey, lastPlan);
  }
  document.addEventListener('invalid', event => set(event.target, 'aria-invalid', 'true'), true);
  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    const thumbnail = link?.querySelector('.proof-thumb');
    if (!thumbnail) return;
    event.preventDefault();
    const viewer = document.createElement('dialog');
    viewer.className = 'a11y-proof-viewer';
    viewer.setAttribute('aria-label', thumbnail.alt || '图片凭证');
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'secondary-btn';
    close.textContent = '关闭图片预览'; close.autofocus = true;
    const picture = document.createElement('img');
    picture.className = 'a11y-proof-image'; picture.src = thumbnail.src; picture.alt = thumbnail.alt;
    viewer.append(close,picture); document.body.append(viewer);
    close.addEventListener('click',()=>viewer.close());
    viewer.addEventListener('close',()=>{viewer.remove();focus(link);},{once:true});
    viewer.showModal();
  });
  document.addEventListener('input', event => {
    if (event.target.validity?.valid) event.target.removeAttribute('aria-invalid');
  }, true);
  document.addEventListener('keydown', event => {
    const target = event.target;
    if (target.matches('.calendar-day') && ['Home','End','PageUp','PageDown'].includes(event.key)) {
      event.preventDefault();
      const date = new Date(target.dataset.date + 'T00:00:00');
      if (event.key === 'Home' || event.key === 'End') {
        const day = (date.getDay() + 6) % 7;
        const steps = event.key === 'Home' ? -day : 6 - day;
        for (let i = 0; i < Math.abs(steps); i++) document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: steps < 0 ? 'ArrowLeft' : 'ArrowRight', bubbles: true }));
      } else {
        const offset = event.key === 'PageUp' ? -1 : 1;
        const month = new Date(date.getFullYear(), date.getMonth() + offset, 1);
        if (month.getFullYear() < 1900 || month.getFullYear() > 2100) return;
        const number = Math.min(date.getDate(), new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate());
        $(`#date-picker [data-calendar-action="month"][data-offset="${offset}"]`)?.click();
        focus(all('.calendar-day:not(:disabled)').find(day => new Date(day.dataset.date + 'T00:00:00').getDate() === number) || $('.calendar-day:not(:disabled)'));
      }
      return;
    }
    if (target.matches('.plan-tab') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = all('.plan-tab'); const index = tabs.indexOf(target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      const level = tabs[next].dataset.level; tabs[next].click();
      enhance(); focus(all('.plan-tab').find(tab => tab.dataset.level === level));
    }
    const picker = $('#date-picker');
    const modal = $('dialog[open]');
    if (modal && !picker?.contains(target) && event.key === 'Tab') {
      const items = all('button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]', modal).filter(visible);
      if (items.length && event.shiftKey && target === items[0]) { event.preventDefault(); focus(items.at(-1)); }
      else if (items.length && !event.shiftKey && target === items.at(-1)) { event.preventDefault(); focus(items[0]); }
    }
    if (picker?.contains(target) && event.key === 'Tab') {
      const items = all('button:not(:disabled),select', picker).filter(visible);
      if (event.shiftKey && target === items[0]) { event.preventDefault(); focus(items.at(-1)); }
      else if (!event.shiftKey && target === items.at(-1)) { event.preventDefault(); focus(items[0]); }
    }
    if (target.closest('#ai-chat-widget') && event.key === 'Escape' && !$('.ai-chat-panel')?.hidden) {
      event.preventDefault(); $('.ai-chat-close').click(); focus($('.ai-chat-fab'));
    }
    if (target.matches('.ai-chat-fab') && event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); const widget = $('#ai-chat-widget'), rect = widget.getBoundingClientRect();
      widget.style.left = Math.max(8, Math.min(innerWidth - widget.offsetWidth - 8, rect.left + (event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0))) + 'px';
      widget.style.top = Math.max(8, Math.min(innerHeight - widget.offsetHeight - 8, rect.top + (event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0))) + 'px';
      widget.style.right = 'auto'; widget.style.bottom = 'auto';
      announce('助手位置已移动');
    }
  }, true);
  new MutationObserver(records => {
    if (records.every(record => record.target === status || status.contains(record.target) || record.target.parentElement?.closest('.a11y-dialog-status'))) return;
    records.forEach(record => {
      if (record.attributeName === 'disabled' && record.target === lastFocus && record.target.disabled) temporarilyDisabled = record.target;
    });
    enhance();
    if (temporarilyDisabled && !temporarilyDisabled.disabled) {
      if (document.activeElement === document.body) focus(temporarilyDisabled);
      temporarilyDisabled = null;
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'open', 'disabled', 'data-busy'] });
  enhance();
})();
