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
  const renderedCards = [];
  const watchedIds = new Set([12]);
  const notifications = [];
  const focusedTargets = [];

  function element(className = '') {
    const classes = new Set(className.split(/\s+/).filter(Boolean));
    return {
      children: [],
      className,
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
        toggle(name, state) { if (state === false) classes.delete(name); else classes.add(name); },
      },
      appendChild(child) {
        if (child.parentNode && child.parentNode !== this) child.remove();
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      addEventListener() {},
      setAttribute(name, value) { this[name] = value; },
      getAttribute(name) { return this[name]; },
      remove() {
        if (!this.parentNode) return;
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
        this.parentNode = null;
      },
    };
  }

  const document = {
    currentScript: null,
    head: element('head'),
    createElement() { return element(); },
    getElementById() { return null; },
  };

  function listener() {
    return { follow() {}, remove() {} };
  }

  function jquery(selector) {
    const isMenu = typeof selector === 'string' && selector.includes('.menu__list');
    const isExistingButton = typeof selector === 'string' && selector.includes('lampa-smart-recs-menu');
    const classMatch = typeof selector === 'string' ? selector.match(/class="([^"]+)"/) : null;
    const node = typeof selector === 'object' ? selector : element(classMatch ? classMatch[1] : '');
    const wrapper = {
      0: node,
      length: isMenu ? 1 : isExistingButton ? 0 : 1,
      on() { return this; },
      eq() { return this; },
      prepend() { return this; },
      detach() { return this; },
      find() { return this; },
      text() { return this; },
      remove() { return this; },
    };
    return wrapper;
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
    Timeline: {
      watched(card) {
        if (watchedIds.has(card.id)) return card.media_type === 'tv' ? [{ ep: 1, view: { percent: 95 } }, { ep: 2, view: { percent: 95 } }] : { percent: 95 };
        return card.media_type === 'tv' ? [] : { percent: 0 };
      },
      listener: listener(),
    },
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
    Activity: { push() {}, backward() {} },
    Background: { change() {} },
    Utils: { cardImgBackground() { return ''; } },
    Layer: { visible() {} },
    Noty: { show(message) { notifications.push(message); } },
    Controller: {
      enabled() { return { name: 'settings' }; },
      toggle() {},
      own() { return true; },
      add() {},
      collectionAppend() {},
      collectionSet() {},
      collectionFocus(target) { focusedTargets.push(target); },
    },
    Select: { show(definition) { lampa.lastSelect = definition; } },
    Input: { edit() {} },
    Scroll: function Scroll() {
      const node = element('scroll');
      this.minus = function minus() {};
      this.update = function update() {};
      this.append = function append(child) { node.appendChild(child); };
      this.render = function render(js) { return js ? node : jquery(node); };
      this.destroy = function destroy() { node.remove(); };
    },
    Card: function Card(data) {
      const node = element('card selector');
      this.data = data;
      this.create = function create() { renderedCards.push(this); };
      this.render = function render(js) { return js ? node : jquery(node); };
      this.destroy = function destroy() { node.remove(); };
    },
  };

  const navigator = {
    setCollection() {},
    focused() {},
    canmove() { return true; },
    move() {},
  };
  const context = {
    window: { appready: true, Navigator: navigator, document },
    document,
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

  storage.set('lampa_smart_recs_feedback', {
    schema: 1,
    items: {
      'movie:11': {
        value: 1,
        card: { id: 11, media_type: 'movie', title: 'Liked candidate', genre_ids: [18], poster_path: '/poster.jpg' },
      },
      'movie:21': {
        value: -1,
        card: { id: 21, media_type: 'movie', title: 'Disliked candidate', genre_ids: [18], poster_path: '/poster.jpg' },
      },
    },
  });
  storage.set('lampa_smart_recs_watch_intents', {
    schema: 1,
    items: {
      'movie:12': {
        openedAt: Date.now(),
        card: { id: 12, media_type: 'movie', title: 'Completed from recommendations', genre_ids: [18], poster_path: '/poster.jpg' },
      },
    },
  });

  vm.runInNewContext(source, context, { filename: 'smart-recs.js' });
  timers.splice(0).forEach((fn) => fn());

  assert.equal(context.window.LampaSmartRecs.version, '0.6.2');
  assert.equal(storage.get('lampa_smart_recs_feedback').schema, 2);
  assert.equal(storage.get('lampa_smart_recs_feedback').items['movie:12'].value, 1);
  assert.equal(storage.get('lampa_smart_recs_feedback').items['movie:12'].tasteWeight, 8);
  assert.equal(storage.get('lampa_smart_recs_feedback').items['movie:12'].source, 'completed_watch');
  assert.equal(Object.keys(storage.get('lampa_smart_recs_watch_intents').items).length, 0);
  assert.equal(components.has('lampa_smart_recs'), true);
  assert.equal(rows.length, 1);
  assert.equal(pluginMenus.length, 0);
  assert.ok(storage.has('lampa_smart_recs_cache'));
  assert.equal(storage.get('lampa_smart_recs_cache').payload.lines.length, 1);
  assert.equal(storage.get('lampa_smart_recs_cache').payload.lines[0].title, 'Для вас');
  assert.ok(storage.get('lampa_smart_recs_cache').payload.lines[0].results.some((card) => card.id === 11));
  assert.equal(storage.get('lampa_smart_recs_cache').payload.lines[0].results.some((card) => card.id === 21), false);
  assert.equal(storage.get('lampa_smart_recs_cache').payload.lines[0].results.some((card) => card.id === 12), false);

  watchedIds.add(11);
  let cachedHomeRow;
  rows[0].call()((payload) => { cachedHomeRow = payload; });
  timers.splice(0).forEach((fn) => fn());
  assert.equal(cachedHomeRow.results.some((card) => card.id === 11), false);
  watchedIds.delete(11);

  const moodUpdatedAt = Date.now() - 60_000;
  storage.set('lampa_smart_recs_mood', {
    schema: 1,
    active: { updatedAt: moodUpdatedAt, expiresAt: moodUpdatedAt + 6 * 60 * 60 * 1000, records: [] },
    draft: null,
  });
  storage.set('lampa_smart_recs_filters', {
    schema: 1,
    configured: true,
    types: { movie: true, tv: true, anime: true, cartoon: true },
    genres: {},
    rating: 0,
  });
  const recommendationComponent = components.get('lampa_smart_recs')({ force: false });
  recommendationComponent.activity = { loader() {}, toggle() {}, canRefresh() { return false; } };
  recommendationComponent.create();
  timers.splice(0).forEach((fn) => fn());
  const initialFeedLength = renderedCards.length;
  const lastInitialCard = renderedCards[initialFeedLength - 1];
  lastInitialCard.onFocus(lastInitialCard.render(true), lastInitialCard.data);
  assert.ok(renderedCards.length > initialFeedLength);
  assert.ok(tmdbRequests.some((request) => request.page >= 3));
  assert.equal(storage.get('lampa_smart_recs_mood').active.expiresAt, moodUpdatedAt + 48 * 60 * 60 * 1000);

  const dislikedCard = renderedCards[0];
  const dislikedNode = dislikedCard.render(true);
  assert.ok(dislikedNode.parentNode);
  dislikedCard.onMenu(dislikedNode, dislikedCard.data);
  lampa.lastSelect.onSelect(lampa.lastSelect.items.find((item) => item.value === -1));
  assert.equal(dislikedNode.parentNode, null);
  assert.equal(storage.get('lampa_smart_recs_feedback').items[`${dislikedCard.data.media_type}:${dislikedCard.data.id}`].value, -1);
  assert.equal(notifications.at(-1), 'Не нравится — скрыто');
  assert.ok(focusedTargets.length > 0);

  const moodReset = settingDefinitions.find((item) => item.param.name === 'lampa_smart_recs_clear_mood');
  const fullReset = settingDefinitions.find((item) => item.param.name === 'lampa_smart_recs_clear_all');
  assert.equal(moodReset.field.name, 'Сбросить текущее настроение');
  assert.equal(fullReset.field.name, 'Начать рекомендации с нуля');
  assert.equal(settingDefinitions.find((item) => item.param.name === 'lampa_smart_recs_hide_seen').field.name, 'Скрывать просмотренное');
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
