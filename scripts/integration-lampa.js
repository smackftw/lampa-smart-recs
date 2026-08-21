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

  socket.close();
  return { state, exceptions, consoleMessages };
}

(async () => {
  try {
    const report = await inspect();
    console.log(JSON.stringify(report, null, 2));
    if (report.state?.plugin !== '0.1.0' || report.state?.menu < 1 || report.state?.cacheLines < 1 || report.exceptions.length) process.exitCode = 1;
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
