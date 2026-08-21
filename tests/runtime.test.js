const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('boots against the current public Lampa plugin surface', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'smart-recs.js'), 'utf8');
  const storage = new Map();
  const settings = new Map();
  const components = new Map();
  const rows = [];
  const pluginMenus = [];
  const timers = [];

  function listener() {
    return { follow() {}, remove() {} };
  }

  function jquery(selector) {
    const isMenu = typeof selector === 'string' && selector.includes('.menu__list');
    const isExistingButton = typeof selector === 'string' && selector.includes('lampa-smart-recs-menu');
    return {
      length: isMenu ? 1 : isExistingButton ? 0 : 1,
      on() { return this; },
      eq() { return this; },
      prepend() { return this; },
      detach() { return this; },
    };
  }

  const manifest = {};
  Object.defineProperty(manifest, 'plugins', {
    set(value) { pluginMenus.push(value); },
  });

  const lampa = {
    Storage: {
      get(name, fallback) { return storage.has(name) ? storage.get(name) : fallback; },
      set(name, value) { storage.set(name, value); },
      field(name) { return storage.has(name) ? storage.get(name) : settings.get(name); },
    },
    Favorite: { get() { return []; }, listener: listener() },
    Timeline: { watched() { return 0; }, listener: listener() },
    Api: {
      sources: {
        tmdb: {
          get(method, params, success) {
            success({
              results: [{
                id: method.includes('/tv/') || method.startsWith('trending/tv') ? 2 : 1,
                media_type: method.startsWith('trending/tv') ? 'tv' : 'movie',
                title: 'Candidate',
                genre_ids: [18],
                vote_average: 8,
                vote_count: 1000,
                release_date: '2025-01-01',
                poster_path: '/poster.jpg',
              }],
            });
          },
        },
      },
    },
    Recomends: { get() { return []; } },
    SettingsApi: {
      addComponent() {},
      addParam(definition) {
        settings.set(definition.param.name, definition.param.default);
      },
    },
    Component: { add(name, component) { components.set(name, component); } },
    ContentRows: { add(row) { rows.push(row); } },
    Manifest: manifest,
    Listener: listener(),
    Activity: { push() {} },
    Noty: { show() {} },
    Input: { edit() {} },
    InteractionMain: function InteractionMain() {},
  };

  const context = {
    window: { appready: true },
    Lampa: lampa,
    $: jquery,
    XMLHttpRequest: function XMLHttpRequest() {},
    console,
    Date,
    JSON,
    Math,
    Number,
    Object,
    String,
    Error,
    isFinite,
    parseInt,
    setTimeout(fn) { timers.push(fn); return timers.length; },
  };

  vm.runInNewContext(source, context, { filename: 'smart-recs.js' });
  timers.splice(0).forEach((fn) => fn());

  assert.equal(context.window.LampaSmartRecs.version, '0.2.0');
  assert.equal(components.has('lampa_smart_recs'), true);
  assert.equal(rows.length, 1);
  assert.equal(pluginMenus.length, 2);
  assert.ok(storage.has('lampa_smart_recs_cache'));
});
