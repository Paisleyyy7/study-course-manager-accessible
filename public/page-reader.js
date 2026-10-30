/* Optional browser speech layer. Does not change business data or requests. */
(() => {
  'use strict';
  const synth = window.speechSynthesis;
  let enabled = false, paused = false, generation = 0, utterance = null;
  let contentTimer, focusTimer, lastContent = '', lastRoot = null;
  const group = document.createElement('div');
  group.className = 'page-reader'; group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '页面朗读控制');
  group.innerHTML = '<button type="button" class="text-btn reader-toggle" role="switch" aria-checked="false">无障碍朗读：关</button><button type="button" class="text-btn reader-pause" hidden>暂停朗读</button><button type="button" class="text-btn reader-restart" hidden>重读页面</button>';
  const toggle = group.querySelector('.reader-toggle');
  const pause = group.querySelector('.reader-pause');
  const restart = group.querySelector('.reader-restart');
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const shown = node => node instanceof Element && !node.closest('[hidden],[aria-hidden="true"],.a11y-sr-only,.page-reader,.a11y-skip') && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length > 0;
  function name(node) {
    const labelled = node.getAttribute('aria-labelledby');
    return clean(node.getAttribute('aria-label') || (labelled && labelled.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ')) || [...(node.labels || [])].map(label => label.textContent).join(' ') || node.getAttribute('alt') || node.textContent || node.getAttribute('title'));
  }
  function control(node) {
    let label = name(node), value = '';
    if (node.matches('input,textarea')) {
      value = node.type === 'password' ? (node.value ? '已填写' : '未填写') : clean(node.value);
      if (node.type === 'checkbox') value = node.checked ? '已选中' : '未选中';
      if (node.type === 'file') value = node.files.length ? '已选择文件' : '未选择文件';
    } else if (node.matches('select')) value = clean(node.selectedOptions[0]?.textContent);
    const state = node.getAttribute('aria-expanded');
    const selected = node.getAttribute('aria-selected');
    const pressed = node.getAttribute('aria-pressed');
    return clean([label, value, node.required ? '必填' : '', state === 'true' ? '已展开' : state === 'false' ? '已折叠' : '', selected === 'true' ? '已选中' : '', pressed === 'true' ? '已按下' : '', node.disabled ? '不可用' : ''].filter(Boolean).join('，'));
  }
  function extract(root) {
    const lines = [];
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) { const value = clean(node.textContent); if (value) lines.push(value); return; }
      if (!(node instanceof Element) || !shown(node) || node.matches('script,style,svg,.demo-note')) return;
      if (node.matches('button,input,textarea,select,[role="tab"]')) { const value = control(node); if (value) lines.push(value + '。'); return; }
      if (node.matches('img,[role="img"],[role="progressbar"]')) {
        lines.push(name(node) + (node.hasAttribute('aria-valuenow') ? '，百分之' + node.getAttribute('aria-valuenow') : '') + '。'); return;
      }
      // A form's visible label is spoken with its input, so it is not repeated.
      if (node.matches('label')) { for (const control of node.querySelectorAll('input,select,textarea')) walk(control); return; }
      for (const child of node.childNodes) walk(child);
      if (node.matches('h1,h2,h3,p,tr,section,li,.field,.stat-card')) lines.push('。');
    }
    if (root) walk(root);
    return clean(lines.join(' ').replace(/(?:。\s*){2,}/g, '。'));
  }
  function currentRoot() { return document.querySelector('#date-picker') || document.querySelector('dialog[open]') || document.querySelector('main'); }
  function notify(message) {
    const toast = document.getElementById('toast');
    if (toast) { toast.textContent = message; toast.className = 'toast error'; toast.hidden = false; }
  }
  function update() {
    const label = enabled ? '无障碍朗读：开' : '无障碍朗读：关';
    if (toggle.textContent !== label) toggle.textContent = label;
    toggle.setAttribute('aria-checked', String(enabled));
    if (pause.hidden !== !enabled) pause.hidden = !enabled;
    if (restart.hidden !== !enabled) restart.hidden = !enabled;
    const pauseLabel = paused ? '继续朗读' : '暂停朗读';
    if (pause.textContent !== pauseLabel) pause.textContent = pauseLabel;
  }
  function stop() {
    generation++; utterance = null; paused = false;
    if (synth) { synth.cancel(); synth.resume(); }
  }
  function speak(content) {
    if (!enabled || !content) return;
    stop(); update();
    const token = generation;
    const sentences = content.match(/[^。！？\n]+[。！？]?/g) || [content];
    const chunks = sentences.flatMap(sentence => {
      const pieces = [];
      for (let i = 0; i < sentence.length; i += 160) pieces.push(sentence.slice(i, i + 160));
      return pieces;
    });
    function next() {
      if (!enabled || token !== generation || !chunks.length) return;
      const item = new SpeechSynthesisUtterance(chunks.shift());
      const voices = synth.getVoices();
      item.voice = voices.find(voice => /^zh[-_]CN$/i.test(voice.lang) && voice.localService) || voices.find(voice => /^zh/i.test(voice.lang)) || null;
      item.lang = item.voice?.lang || 'zh-CN'; item.rate = 1; item.volume = 1;
      utterance = item; // Retain the native utterance until its callbacks finish.
      item.onend = () => { if (token === generation) next(); };
      item.onerror = event => {
        if (token !== generation || ['canceled', 'interrupted'].includes(event.error)) return;
        enabled = false; stop(); update();
        notify('朗读未能启动，请确认浏览器允许播放声音，并使用具有中文语音的 Microsoft Edge。');
      };
      synth.speak(item);
    }
    next();
  }
  function readPage(prefix = '') {
    lastRoot = currentRoot(); lastContent = extract(lastRoot);
    speak(prefix + (lastContent || '当前页面暂无可朗读内容。'));
  }
  toggle.addEventListener('click', () => {
    if (!synth || !window.SpeechSynthesisUtterance) { notify('当前浏览器不支持页面朗读，请使用 Microsoft Edge。'); return; }
    enabled = !enabled;
    if (enabled) { update(); readPage('无障碍朗读已开启。'); }
    else { stop(); clearTimeout(contentTimer); clearTimeout(focusTimer); update(); }
  });
  pause.addEventListener('click', () => {
    if (!enabled) return;
    if (paused && (currentRoot() !== lastRoot || extract(currentRoot()) !== lastContent)) { readPage(); return; }
    if (!synth.speaking && !synth.pending && !paused) { readPage(); return; }
    paused = !paused;
    if (paused) synth.pause(); else synth.resume();
    update();
  });
  restart.addEventListener('click', () => readPage());
  document.addEventListener('focusin', event => {
    if (!enabled || paused || group.contains(event.target) || !shown(event.target)) return;
    const node = event.target;
    if (!node.matches('button,a,input,select,textarea,[role="tab"]')) return;
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => { if (enabled && !paused && node.isConnected) speak(control(node)); }, 140);
  });
  function mount() {
    const host = document.querySelector('.account') || document.querySelector('.auth-header');
    if (host && group.parentElement !== host) host.append(group);
  }
  new MutationObserver(records => {
    if (records.every(record => group.contains(record.target))) return;
    mount();
    if (!enabled || paused) return;
    // Only visible page changes trigger a new reading. Unchanged reminder polling is ignored.
    clearTimeout(contentTimer);
    contentTimer = setTimeout(() => {
      if (!enabled || paused) return;
      const root = currentRoot(), content = extract(root);
      if (content && (root !== lastRoot || content !== lastContent)) {
        lastRoot = root; lastContent = content; speak(content);
      }
    }, 350);
    const live = records.map(record => record.target instanceof Element ? record.target.closest('#toast,#a11y-announcements,.a11y-dialog-status') : record.target.parentElement?.closest('#toast,#a11y-announcements,.a11y-dialog-status')).find(node => node && !node.closest('[hidden],[aria-hidden="true"]'));
    if (live && clean(live.textContent)) speak(clean(live.textContent));
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'open'] });
  window.addEventListener('pagehide', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden && enabled) { stop(); enabled = false; update(); } });
  synth?.getVoices();
  mount(); update();
})();
