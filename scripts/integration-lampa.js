#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const chrome = process.env.CHROME_PATH;
const targetUrl = process.env.LAMPA_URL || 'http://127.0.0.1:3000';
const port = Number(process.env.CHROME_DEBUG_PORT || 9227);

if (!chrome || !fs.existsSync(chrome)) {
  console.error('Set CHROME_PATH to an installed Chrome/Chromium executable.');
  process.exit(2);
}

const profile = path.join(os.tmpdir(), `lampa-smart-recs-integration-${process.pid}`);
fs.mkdirSync(profile, { recursive: true });

const browser = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
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
    source: "localStorage.setItem('language', 'ru')",
  });
  await evaluate("localStorage.setItem('language', 'ru')");
  await command('Page.reload', { ignoreCache: true });
  await delay(500);

  let state;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    state = await evaluate(`({
      appready: Boolean(window.appready),
      language: localStorage.getItem('language'),
      plugin: window.LampaSmartRecs && window.LampaSmartRecs.version,
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
  let recommendationScreen;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    recommendationScreen = await evaluate(`({
      entry: document.querySelectorAll('.smart-recs-mood-entry').length,
      title: document.querySelector('.smart-recs-mood-entry__title')?.textContent || ''
    })`);
    if (recommendationScreen.entry) break;
    await delay(250);
  }

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

  if (process.env.SCREENSHOT_PATH) {
    await delay(1200);
    const capture = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.SCREENSHOT_PATH, Buffer.from(capture.data, 'base64'));
  }

  const firstMoodTitle = moodScreen.cardTitle;
  await evaluate("window.Lampa.Controller.move('right')");
  await delay(50);
  await evaluate("window.Lampa.Controller.enter()");
  let remoteNavigation;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    remoteNavigation = await evaluate(`({
      records: window.Lampa?.Storage?.get('lampa_smart_recs_mood', {})?.draft?.records?.length || 0,
      cardTitle: document.querySelector('.smart-recs-mood__title')?.textContent || '',
      iframe: document.querySelectorAll('.smart-recs-mood__media iframe').length,
      status: document.querySelector('.smart-recs-mood__status')?.textContent || ''
    })`);
    if (remoteNavigation.records === 1 && remoteNavigation.cardTitle && remoteNavigation.cardTitle !== firstMoodTitle) break;
    await delay(250);
  }

  const leftFocused = await evaluate("(() => { window.Lampa.Controller.move('left'); return document.querySelector('.smart-recs-mood__button--watch')?.classList.contains('focus') || false })()");
  await evaluate("window.Lampa.Controller.back(); true");
  await delay(200);
  const afterBack = await evaluate(`({
    overlay: document.querySelectorAll('.smart-recs-mood').length,
    controller: window.Lampa?.Controller?.enabled()?.name || '',
    draftRecords: window.Lampa?.Storage?.get('lampa_smart_recs_mood', {})?.draft?.records?.length || 0
  })`);

  await evaluate("window.LampaSmartRecs.calibrate(); true");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await evaluate("document.querySelectorAll('.smart-recs-mood').length")) break;
    await delay(250);
  }
  for (let target = 2; target <= 10; target += 1) {
    await evaluate("window.Lampa.Controller.move('right')");
    await delay(20);
    await evaluate("window.Lampa.Controller.enter()");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const records = await evaluate("window.Lampa?.Storage?.get('lampa_smart_recs_mood', {})?.draft?.records?.length || 0");
      if (records >= target) break;
      await delay(50);
    }
  }
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

  socket.close();
  return { state, recommendationScreen, moodScreen, remoteNavigation, leftFocused, afterBack, moodActivation, exceptions, consoleMessages };
}

(async () => {
  try {
    const report = await inspect();
    console.log(JSON.stringify(report, null, 2));
    if (report.state?.plugin !== '0.2.0' || report.state?.menu < 1 || report.state?.cacheLines < 1 ||
      report.recommendationScreen?.entry !== 1 || report.moodScreen?.overlay !== 1 ||
      report.moodScreen?.buttons?.join('|') !== 'Смотреть|Дальше' ||
      report.moodScreen?.controller !== 'smart_recs_mood' || report.remoteNavigation?.records !== 1 ||
      !report.leftFocused || report.afterBack?.overlay !== 0 || report.afterBack?.draftRecords !== 1 ||
      report.moodActivation?.activeRecords !== 10 || report.moodActivation?.hasDraft ||
      report.moodActivation?.recommendationEntry !== 1 || report.moodActivation?.profileSignals < 10 ||
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
