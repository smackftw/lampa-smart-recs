#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const chrome = process.env.CHROME_PATH;
const targetUrl = process.env.LAMPA_URL || 'http://127.0.0.1:3000';
const port = Number(process.env.CHROME_DEBUG_PORT || 9227);
const pluginSource = fs.readFileSync(path.join(__dirname, '..', 'smart-recs.js'), 'utf8');

if (!chrome || !fs.existsSync(chrome)) {
  console.error('Set CHROME_PATH to an installed Chrome/Chromium executable.');
  process.exit(2);
}

const profile = path.join(os.tmpdir(), `lampa-smart-recs-integration-${process.pid}`);
fs.mkdirSync(profile, { recursive: true });

const browser = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
  '--disable-extensions',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  targetUrl,
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

let browserLog = '';
browser.stderr.on('data', (chunk) => { browserLog += String(chunk); });

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findPage() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === 'page');
      if (page) return page;
    } catch {}
    await delay(200);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function inspect() {
  const phase = (name) => process.stderr.write(`[integration] ${name}\n`);
  phase('starting');
  const page = await findPage();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const exceptions = [];
  const consoleMessages = [];
  let commandId = 0;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const operation = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) operation.reject(new Error(message.error.message));
      else operation.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''));
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const values = message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
      consoleMessages.push(`${message.params.type}: ${values}`);
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  function command(method, params = {}) {
    commandId += 1;
    return new Promise((resolve, reject) => {
      pending.set(commandId, { resolve, reject });
      socket.send(JSON.stringify({ id: commandId, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true });
    return result.result.value;
  }

  await command('Runtime.enable');
  await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      localStorage.setItem('language', 'ru');
      (() => {
        const installSmartRecs = () => {
          if (window.Lampa?.Listener) {
            ${pluginSource}
          } else {
            setTimeout(installSmartRecs, 25);
          }
        };
        installSmartRecs();
      })();
    `,
  });
  await evaluate("localStorage.setItem('language', 'ru')");
  await command('Page.reload', { ignoreCache: true });
  await delay(500);

  let state;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    state = await evaluate(`({
      appready: Boolean(window.appready),
      language: localStorage.getItem('language'),
      plugin: document.getElementById('lampa-smart-recs-style')?.getAttribute('data-smart-recs-version') || window.LampaSmartRecs?.version,
      menu: document.querySelectorAll('.lampa-smart-recs-menu').length,
      appChildren: document.querySelector('#app')?.children.length || 0,
      cacheLines: (() => {
        const cache = window.Lampa?.Storage?.get('lampa_smart_recs_cache', {}) || {};
        return cache.payload?.lines?.length || 0;
      })(),
      cacheCandidates: (() => {
        const cache = window.Lampa?.Storage?.get('lampa_smart_recs_cache', {}) || {};
        return cache.payload?.meta?.candidates || 0;
      })()
    })`);
    if (state.plugin && state.menu && state.cacheLines) break;
    await delay(250);
  }

  await evaluate("window.LampaSmartRecs.open(); true");
  await evaluate(`(() => {
    window.__smartRecsBridgeMessages = [];
    window.addEventListener('message', (event) => {
      if (event.data?.bridgeId?.startsWith('smart_recs_') && event.data.type !== 'time') {
        window.__smartRecsBridgeMessages.push({ bridgeId: event.data.bridgeId, type: event.data.type, data: event.data.data || {} });
      }
    });
    return true;
  })()`);
  let recommendationScreen;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    recommendationScreen = await evaluate(`({
      filterEntry: document.querySelectorAll('.smart-recs-filter-entry').length,
      entry: document.querySelectorAll('.smart-recs-mood-entry').length,
      title: document.querySelector('.smart-recs-mood-entry__title')?.textContent || '',
      filterSummary: document.querySelector('.smart-recs-filter-entry__subtitle')?.textContent || '',
      sameRow: (() => {
        const filter = document.querySelector('.smart-recs-filter-entry');
        const mood = document.querySelector('.smart-recs-mood-entry');
        return Boolean(filter && mood && filter.closest('.smart-recs-actions-row') === mood.closest('.smart-recs-actions-row'));
      })(),
      gridCards: document.querySelectorAll('.smart-recs-grid .card').length,
      missingTitles: Array.from(document.querySelectorAll('.smart-recs-grid .card')).filter((item) => !item.querySelector('.card__title')?.textContent.trim()).length,
      gridRows: new Set(Array.from(document.querySelectorAll('.smart-recs-grid .card')).map((item) => Math.round(item.getBoundingClientRect().top))).size
    })`);
    if (recommendationScreen.entry && recommendationScreen.filterEntry && recommendationScreen.sameRow && recommendationScreen.gridRows > 1 && !recommendationScreen.missingTitles) break;
    await delay(250);
  }

  let filterPrompt;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    filterPrompt = await evaluate(`({
      opened: document.querySelectorAll('.smart-recs-filter-editor').length,
      title: document.querySelector('.modal__title')?.textContent || '',
      types: document.querySelectorAll('.smart-recs-filter-chip[data-filter-kind="type"]').length,
      genres: document.querySelectorAll('.smart-recs-filter-chip[data-filter-kind="genre"]').length,
      ratings: document.querySelectorAll('.smart-recs-filter-chip[data-filter-kind="rating"]').length
    })`);
    if (filterPrompt.opened) break;
    await delay(100);
  }
  if (!filterPrompt?.opened) {
    await evaluate("(() => { const card = document.querySelector('.smart-recs-filter-entry'); if (card) window.Lampa.Utils.trigger(card, 'hover:enter'); return Boolean(card); })()");
    await delay(200);
  }

  const filterSelection = await evaluate(`(() => {
    const trigger = (selector, times = 1) => {
      const item = document.querySelector(selector);
      for (let index = 0; item && index < times; index += 1) window.Lampa.Utils.trigger(item, 'hover:enter');
    };
    trigger('.smart-recs-filter-chip[data-filter-kind="type"][data-filter-id="tv"]');
    trigger('.smart-recs-filter-chip[data-filter-kind="type"][data-filter-id="anime"]');
    trigger('.smart-recs-filter-chip[data-filter-kind="type"][data-filter-id="cartoon"]');
    trigger('.smart-recs-filter-chip[data-filter-kind="genre"][data-filter-id="science_fiction"]');
    trigger('.smart-recs-filter-chip[data-filter-kind="genre"][data-filter-id="horror"]', 2);
    trigger('.smart-recs-filter-chip[data-filter-kind="rating"][data-filter-id="7"]');
    return {
      selectedTypes: Array.from(document.querySelectorAll('.smart-recs-filter-chip[data-filter-kind="type"].is-selected')).map((item) => item.dataset.filterId),
      wanted: Array.from(document.querySelectorAll('.smart-recs-filter-chip.is-wanted')).map((item) => item.dataset.filterId),
      excluded: Array.from(document.querySelectorAll('.smart-recs-filter-chip.is-excluded')).map((item) => item.dataset.filterId),
      rating: document.querySelector('.smart-recs-filter-chip[data-filter-kind="rating"].is-selected')?.dataset.filterId || ''
    };
  })()`);
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.modal__button')).find((item) => item.textContent.trim() === 'Показать');
    if (button) window.Lampa.Utils.trigger(button, 'hover:enter');
    return Boolean(button);
  })()`);

  let filterResult;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    filterResult = await evaluate(`(() => {
      const filters = window.Lampa?.Storage?.get('lampa_smart_recs_filters', {}) || {};
      const cache = window.Lampa?.Storage?.get('lampa_smart_recs_cache', {}) || {};
      const cards = (cache.payload?.lines || []).flatMap((line) => line.results || []);
      return {
        modal: document.querySelectorAll('.smart-recs-filter-editor').length,
        configured: filters.configured === true,
        types: filters.types || {},
        genres: filters.genres || {},
        rating: filters.rating || 0,
        summary: document.querySelector('.smart-recs-filter-entry__subtitle')?.textContent || '',
        cards: cards.length,
        invalid: cards.filter((card) => card.media_type !== 'movie' || (card.genre_ids || []).includes(16) || !(card.genre_ids || []).includes(878) || (card.genre_ids || []).includes(27) || card.vote_average < 7 || card.vote_count < 100).length
      };
    })()`);
    if (!filterResult.modal && filterResult.configured && filterResult.cards > 0 && filterResult.summary.includes('7+')) break;
    await delay(250);
  }
  phase('filters applied');
  if (!filterResult?.configured || filterResult.cards < 1 || filterResult.invalid !== 0) throw new Error(`Filter stage failed: ${JSON.stringify(filterResult)}`);

  await evaluate("(() => { const card = document.querySelector('.activity--active .card.selector'); if (card) window.Lampa.Utils.trigger(card, 'hover:long'); return Boolean(card) })()");
  await delay(100);
  const tasteMenu = await evaluate(`({
    opened: document.body.classList.contains('selectbox--open'),
    title: document.querySelector('.selectbox__title')?.textContent || '',
    items: Array.from(document.querySelectorAll('.selectbox-item__title')).map((item) => item.textContent.trim())
  })`);
  await evaluate("window.Lampa.Controller.back(); true");
  await delay(100);

  await evaluate("window.LampaSmartRecs.calibrate(); true");
  let moodScreen;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    moodScreen = await evaluate(`({
      overlay: document.querySelectorAll('.smart-recs-mood').length,
      buttons: Array.from(document.querySelectorAll('.smart-recs-mood__button')).map((item) => item.textContent.trim()),
      controller: window.Lampa?.Controller?.enabled()?.name || '',
      iframe: document.querySelectorAll('.smart-recs-mood__media iframe').length,
      cardTitle: document.querySelector('.smart-recs-mood__title')?.textContent || ''
    })`);
    if (moodScreen.overlay && moodScreen.buttons.length === 2 && moodScreen.controller === 'smart_recs_mood') break;
    await delay(250);
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    moodScreen = await evaluate(`({
      overlay: document.querySelectorAll('.smart-recs-mood').length,
      buttons: Array.from(document.querySelectorAll('.smart-recs-mood__button')).map((item) => item.textContent.trim()),
      controller: window.Lampa?.Controller?.enabled()?.name || '',
      iframe: document.querySelectorAll('.smart-recs-mood__media iframe').length,
      ready: document.querySelector('.smart-recs-mood__media iframe')?.classList.contains('ready') || false,
      cardTitle: document.querySelector('.smart-recs-mood__title')?.textContent || '',
      status: document.querySelector('.smart-recs-mood__status')?.textContent || ''
    })`);
    if (moodScreen.ready || moodScreen.status.includes('Трейлер не найден') || moodScreen.status.includes('Трейлер недоступен')) break;
    await delay(250);
  }
  phase('first trailer playing');
  if (moodScreen?.iframe === 1 && !moodScreen?.ready) throw new Error(`First trailer failed: ${JSON.stringify(moodScreen)}`);

  if (process.env.SCREENSHOT_PATH) {
    await delay(1200);
    const capture = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.SCREENSHOT_PATH, Buffer.from(capture.data, 'base64'));
  }
  const firstMoodTitle = moodScreen.cardTitle;
  const leftSelection = await evaluate(`(() => {
    window.Lampa.Controller.move('left');
    return {
      watchFocused: document.querySelector('.smart-recs-mood__button--watch')?.classList.contains('focus') || false,
      records: window.Lampa?.Storage?.get('lampa_smart_recs_mood', {})?.draft?.records?.length || 0
    };
  })()`);
  if (process.env.TRAILER_ONLY === '1') {
    await evaluate(`(() => {
      const source = document.querySelector('.smart-recs-mood__media iframe')?.getAttribute('src') || '';
      const parsed = new URL(source, location.href);
      window.dispatchEvent(new MessageEvent('message', { data: {
        bridgeId: parsed.searchParams.get('bridgeId'),
        type: 'stateChange',
        data: { state: 0, sequence: Number(parsed.searchParams.get('sequence') || 1) }
      }}));
      return true;
    })()`);
  } else {
    await evaluate("window.Lampa.Controller.move('right')");
  }
  let remoteNavigation;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    remoteNavigation = await evaluate(`({
      records: window.Lampa?.Storage?.get('lampa_smart_recs_mood', {})?.draft?.records?.length || 0,
      cardTitle: document.querySelector('.smart-recs-mood__title')?.textContent || '',
      iframe: document.querySelectorAll('.smart-recs-mood__media iframe').length,
      ready: document.querySelector('.smart-recs-mood__media iframe')?.classList.contains('ready') || false,
      iframeSrc: document.querySelector('.smart-recs-mood__media iframe')?.getAttribute('src') || '',
      status: document.querySelector('.smart-recs-mood__status')?.textContent || ''
    })`);
    const previewResolved = remoteNavigation.ready || remoteNavigation.status.includes('Трейлер не найден') || remoteNavigation.status.includes('Трейлер недоступен');
    if (remoteNavigation.records === 1 && remoteNavigation.cardTitle && remoteNavigation.cardTitle !== firstMoodTitle && previewResolved) break;
    await delay(250);
  }
  if (remoteNavigation?.iframe === 1 && !remoteNavigation?.ready) throw new Error(`Second trailer failed: ${JSON.stringify(remoteNavigation)}`);

  if (process.env.TRAILER_ONLY === '1') {
    const bridgeMessages = await evaluate("window.__smartRecsBridgeMessages || []");
    socket.close();
    return { state, recommendationScreen, filterPrompt, filterSelection, filterResult, moodScreen, leftSelection, remoteNavigation, bridgeMessages, exceptions, consoleMessages };
  }

  const secondMoodTitle = remoteNavigation.cardTitle;
  await evaluate("window.Lampa.Controller.long()");
  await delay(100);
  const moodTasteMenu = await evaluate(`({
    opened: document.body.classList.contains('selectbox--open'),
    title: document.querySelector('.selectbox__title')?.textContent || '',
    items: Array.from(document.querySelectorAll('.selectbox-item__title')).map((item) => item.textContent.trim())
  })`);
  await evaluate("window.Lampa.Controller.enter()");
  let likedNavigation;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    likedNavigation = await evaluate(`({
      records: window.Lampa?.Storage?.get('lampa_smart_recs_mood', {})?.draft?.records?.length || 0,
      cardTitle: document.querySelector('.smart-recs-mood__title')?.textContent || '',
      iframe: document.querySelectorAll('.smart-recs-mood__media iframe').length,
      ready: document.querySelector('.smart-recs-mood__media iframe')?.classList.contains('ready') || false,
      iframeSrc: document.querySelector('.smart-recs-mood__media iframe')?.getAttribute('src') || '',
      status: document.querySelector('.smart-recs-mood__status')?.textContent || '',
      feedback: Object.values(window.Lampa?.Storage?.get('lampa_smart_recs_feedback', {})?.items || {}).map((item) => item.value).sort()
    })`);
    const previewResolved = likedNavigation.ready || likedNavigation.status.includes('Трейлер не найден') || likedNavigation.status.includes('Трейлер недоступен');
    if (likedNavigation.records === 2 && likedNavigation.cardTitle && likedNavigation.cardTitle !== secondMoodTitle && previewResolved) break;
    await delay(100);
  }
  phase('long OK transition playing');
  if (likedNavigation?.iframe === 1 && !likedNavigation?.ready) throw new Error(`Long OK trailer failed: ${JSON.stringify(likedNavigation)}`);

  await evaluate("window.Lampa.Controller.back(); true");
  await delay(200);
  const afterBack = await evaluate(`({
    overlay: document.querySelectorAll('.smart-recs-mood').length,
    controller: window.Lampa?.Controller?.enabled()?.name || '',
    draftRecords: window.Lampa?.Storage?.get('lampa_smart_recs_mood', {})?.draft?.records?.length || 0
  })`);

  await evaluate("window.LampaSmartRecs.calibrate(); true");
  let resumed = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    resumed = Boolean(await evaluate("document.querySelectorAll('.smart-recs-mood').length"));
    if (resumed) break;
    await delay(250);
  }
  if (!resumed) throw new Error(`Draft did not resume: ${JSON.stringify(afterBack)}`);
  for (let target = 3; target <= 10; target += 1) {
    await evaluate("window.Lampa.Controller.move('right')");
    let records = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      records = await evaluate("window.Lampa?.Storage?.get('lampa_smart_recs_mood', {})?.draft?.records?.length || 0");
      if (records >= target) break;
      await delay(50);
    }
    if (records < target) throw new Error(`Rating ${target} was not recorded; got ${records}`);
  }
  phase('ten ratings recorded');
  await evaluate("window.Lampa.Controller.back(); true");
  let moodActivation;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    moodActivation = await evaluate(`({
      overlay: document.querySelectorAll('.smart-recs-mood').length,
      activeRecords: window.Lampa?.Storage?.get('lampa_smart_recs_mood', {})?.active?.records?.length || 0,
      hasDraft: Boolean(window.Lampa?.Storage?.get('lampa_smart_recs_mood', {})?.draft),
      recommendationEntry: document.querySelectorAll('.smart-recs-mood-entry').length,
      profileSignals: window.Lampa?.Storage?.get('lampa_smart_recs_cache', {})?.payload?.meta?.signals || 0
    })`);
    if (moodActivation.activeRecords === 10 && !moodActivation.hasDraft && moodActivation.recommendationEntry === 1 && moodActivation.profileSignals >= 10) break;
    await delay(250);
  }
  phase('mood activated');
  if (moodActivation?.activeRecords !== 10 || moodActivation?.hasDraft || moodActivation?.profileSignals < 10) throw new Error(`Mood activation failed: ${JSON.stringify(moodActivation)}`);


  await evaluate("window.LampaSmartRecs.calibrate(); true");
  let watchSessionOpened = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    watchSessionOpened = Boolean(await evaluate("document.querySelectorAll('.smart-recs-mood').length"));
    if (watchSessionOpened) break;
    await delay(250);
  }
  if (!watchSessionOpened) throw new Error('Watch trailer session did not open');
  const watchBefore = await evaluate(`(() => {
    const title = document.querySelector('.smart-recs-mood__title')?.textContent || '';
    window.Lampa.Controller.move('left');
    return {
      title,
      focused: document.querySelector('.smart-recs-mood__button--watch')?.classList.contains('focus') || false,
      component: window.Lampa?.Activity?.active()?.component || ''
    };
  })()`);
  phase('watch action focused');
  await evaluate("window.Lampa.Controller.enter()");
  let watchAction;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    watchAction = await evaluate(`({
      overlay: document.querySelectorAll('.smart-recs-mood').length,
      component: window.Lampa?.Activity?.active()?.component || '',
      positiveFeedback: Object.values(window.Lampa?.Storage?.get('lampa_smart_recs_feedback', {})?.items || {}).filter((item) => item.value > 0).length
    })`);
    if (watchAction.overlay === 0 && watchAction.component === 'full' && watchAction.positiveFeedback >= 2) break;
    await delay(250);
  }
  phase('movie card opened');
  if (watchAction?.overlay !== 0 || watchAction?.component !== 'full' || watchAction?.positiveFeedback < 2) throw new Error(`Watch action failed: ${JSON.stringify(watchAction)}`);

  const bridgeMessages = await evaluate("window.__smartRecsBridgeMessages || []");
  socket.close();
  return { state, recommendationScreen, filterPrompt, filterSelection, filterResult, tasteMenu, moodScreen, leftSelection, remoteNavigation, moodTasteMenu, likedNavigation, afterBack, moodActivation, watchBefore, watchAction, bridgeMessages, exceptions, consoleMessages };
}

(async () => {
  try {
    const report = await inspect();
    console.log(JSON.stringify(report, null, 2));
    if (process.env.TRAILER_ONLY === '1') {
      if (report.recommendationScreen?.gridRows < 2 || report.recommendationScreen?.missingTitles !== 0 ||
        report.filterPrompt?.title !== 'Что показать сейчас' || report.filterPrompt?.types !== 4 || report.filterPrompt?.genres !== 8 || report.filterPrompt?.ratings !== 5 ||
        report.filterSelection?.selectedTypes?.join('|') !== 'movie' || report.filterSelection?.wanted?.join('|') !== 'science_fiction' ||
        report.filterSelection?.excluded?.join('|') !== 'horror' || report.filterSelection?.rating !== '7' ||
        !report.filterResult?.configured || report.filterResult?.cards < 1 || report.filterResult?.invalid !== 0 ||
        (report.moodScreen?.iframe === 1 && !report.moodScreen?.ready) ||
        (report.remoteNavigation?.iframe === 1 && !report.remoteNavigation?.ready) ||
        report.exceptions.length) process.exitCode = 1;
      return;
    }
    if (report.state?.plugin !== '0.4.0' || report.state?.menu < 1 || report.state?.cacheLines < 1 ||
      report.recommendationScreen?.entry !== 1 || report.recommendationScreen?.filterEntry !== 1 || !report.recommendationScreen?.sameRow || report.recommendationScreen?.gridRows < 2 || report.recommendationScreen?.missingTitles !== 0 ||
      report.filterPrompt?.title !== 'Что показать сейчас' || report.filterPrompt?.types !== 4 || report.filterPrompt?.genres !== 8 || report.filterPrompt?.ratings !== 5 ||
      report.filterSelection?.selectedTypes?.join('|') !== 'movie' || report.filterSelection?.wanted?.join('|') !== 'science_fiction' ||
      report.filterSelection?.excluded?.join('|') !== 'horror' || report.filterSelection?.rating !== '7' ||
      !report.filterResult?.configured || report.filterResult?.cards < 1 || report.filterResult?.invalid !== 0 ||
      report.moodScreen?.overlay !== 1 ||
      !report.tasteMenu?.opened || report.tasteMenu?.title !== 'Оценить рекомендацию' ||
      report.tasteMenu?.items?.join('|') !== 'Нравится|Не нравится' ||
      report.moodScreen?.buttons?.join('|') !== 'Смотреть|Дальше' ||
      (report.moodScreen?.iframe === 1 && !report.moodScreen?.ready) ||
      report.moodScreen?.controller !== 'smart_recs_mood' || !report.leftSelection?.watchFocused || report.leftSelection?.records !== 0 ||
      report.remoteNavigation?.records !== 1 ||
      (report.remoteNavigation?.iframe === 1 && !report.remoteNavigation?.ready) ||
      report.remoteNavigation?.status?.includes('Нажмите') ||
      (report.remoteNavigation?.iframe === 1 && !report.remoteNavigation?.iframeSrc?.includes('autoplay=1')) ||
      !report.moodTasteMenu?.opened || report.moodTasteMenu?.title !== 'Оценить трейлер' ||
      report.moodTasteMenu?.items?.join('|') !== 'Нравится|Не нравится' ||
      report.likedNavigation?.records !== 2 || report.likedNavigation?.feedback?.join('|') !== '-1|1' ||
      (report.likedNavigation?.iframe === 1 && !report.likedNavigation?.ready) ||
      (report.likedNavigation?.iframe === 1 && !report.likedNavigation?.iframeSrc?.includes('autoplay=1')) ||
      report.afterBack?.overlay !== 0 || report.afterBack?.draftRecords !== 2 ||
      report.moodActivation?.activeRecords !== 10 || report.moodActivation?.hasDraft ||
      report.moodActivation?.recommendationEntry !== 1 || report.moodActivation?.profileSignals < 10 ||
      !report.watchBefore?.focused || report.watchAction?.overlay !== 0 || report.watchAction?.component !== 'full' ||
      report.watchAction?.positiveFeedback < 2 ||
      report.exceptions.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error.message);
    console.error(browserLog.slice(-4000));
    process.exitCode = 1;
  } finally {
    browser.kill();
    await delay(300);
    const safePrefix = path.join(os.tmpdir(), 'lampa-smart-recs-integration-');
    if (profile.startsWith(safePrefix)) fs.rmSync(profile, { recursive: true, force: true });
  }
})();
