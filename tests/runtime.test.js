const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('boots against the current public Lampa plugin surface', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'smart-recs.js'), 'utf8');
  const storage = new Map();
  const settings = new Map();
  const settingDefinitions = [];
  const components = new Map();
  const rows = [];
  const pluginMenus = [];
  const timers = [];
  const tmdbRequests = [];
  let builtLines = [];
  let feedLine;
  let feedAttachCount = 0;

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
    Favorite: { get() { throw new Error('Favorite must not be read'); }, listener: listener() },
    Timeline: { watched() { throw new Error('Timeline must not be read'); }, listener: listener() },
    Api: {
      sources: {
        tmdb: {
          get(method, params, success) {
            const page = Number(params?.page || 1);
            const type = method.includes('/tv/') || method.startsWith('trending/tv') || method === 'discover/tv' ? 'tv' : 'movie';
            tmdbRequests.push({ method, page });
            success({
              results: [{
                id: page * 10 + (type === 'tv' ? 2 : 1),
                media_type: type,
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
    Recomends: { get() { throw new Error('Native recommendations must not be read'); } },
    SettingsApi: {
      addComponent() {},
      addParam(definition) {
        settingDefinitions.push(definition);
        settings.set(definition.param.name, definition.param.default);
      },
    },
    Component: { add(name, component) { components.set(name, component); } },
    ContentRows: { add(row) { rows.push(row); } },
    Manifest: manifest,
    Listener: listener(),
    Activity: { push() {} },
    Noty: { show() {} },
    Controller: {
      enabled() { return { name: 'settings' }; },
      toggle() {},
    },
    Select: { show(definition) { lampa.lastSelect = definition; } },
    Input: { edit() {} },
    InteractionMain: function InteractionMain() {
      this.activity = { loader() {} };
      this.build = function build(lines) {
        builtLines = lines;
        lines.forEach((data) => {
          const line = { attach() { feedAttachCount += 1; } };
          if (this.onAppend) this.onAppend(line, data);
          if (data.smart_recs_feed) feedLine = line;
        });
      };
      this.render = function render() { return {}; };
      this.destroy = function destroy() {};
    },
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

  assert.equal(context.window.LampaSmartRecs.version, '0.3.3');
  assert.equal(components.has('lampa_smart_recs'), true);
  assert.equal(rows.length, 1);
  assert.equal(pluginMenus.length, 0);
  assert.ok(storage.has('lampa_smart_recs_cache'));
  assert.equal(storage.get('lampa_smart_recs_cache').payload.lines.length, 1);
  assert.equal(storage.get('lampa_smart_recs_cache').payload.lines[0].title, 'Для вас');

  const recommendationComponent = components.get('lampa_smart_recs')({ force: false });
  recommendationComponent.create();
  timers.splice(0).forEach((fn) => fn());
  const feed = builtLines.find((line) => line.smart_recs_feed);
  const initialFeedLength = feed.results.length;
  feedLine.onFocus(feed.results[initialFeedLength - 1]);
  assert.ok(feed.results.length > initialFeedLength);
  assert.ok(feedAttachCount > 0);
  assert.ok(tmdbRequests.some((request) => request.page >= 3));

  const moodReset = settingDefinitions.find((item) => item.param.name === 'lampa_smart_recs_clear_mood');
  const fullReset = settingDefinitions.find((item) => item.param.name === 'lampa_smart_recs_clear_all');
  assert.equal(moodReset.field.name, 'Сбросить текущее настроение');
  assert.equal(fullReset.field.name, 'Начать рекомендации с нуля');
  assert.equal(settingDefinitions.some((item) => item.param.name === 'lampa_smart_recs_clear_feedback'), false);

  storage.set('lampa_smart_recs_feedback', { schema: 1, items: { movie: { value: 1 } } });
  storage.set('lampa_smart_recs_mood', { schema: 1, active: { records: [1] }, draft: { records: [2] } });
  moodReset.onChange();
  assert.equal(Object.keys(storage.get('lampa_smart_recs_feedback').items).length, 1);
  assert.equal(storage.get('lampa_smart_recs_mood').active, null);
  assert.equal(storage.get('lampa_smart_recs_mood').draft, null);

  storage.set('lampa_smart_recs_mood', { schema: 1, active: { records: [1] }, draft: null });
  fullReset.onChange();
  assert.equal(lampa.lastSelect.title, 'Начать рекомендации с нуля?');
  lampa.lastSelect.onSelect(lampa.lastSelect.items[0]);
  assert.equal(Object.keys(storage.get('lampa_smart_recs_feedback').items).length, 0);
  assert.equal(storage.get('lampa_smart_recs_mood').active, null);
  assert.equal(Object.keys(storage.get('lampa_smart_recs_cache')).length, 0);
});
