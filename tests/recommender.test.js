const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadCore() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'smart-recs.js'), 'utf8');
  const context = {
    window: { __LAMPA_SMART_RECS_TEST__: true },
    console,
    Date,
    JSON,
    Math,
    Number,
    Object,
    String,
    isFinite,
    parseInt,
  };
  vm.runInNewContext(source, context, { filename: 'smart-recs.js' });
  return context.window.LampaSmartRecsTest;
}

function movie(id, genres, extra = {}) {
  return {
    id,
    title: extra.title || `Movie ${id}`,
    media_type: extra.media_type || 'movie',
    genre_ids: genres,
    vote_average: extra.vote_average ?? 7.5,
    vote_count: extra.vote_count ?? 1500,
    release_date: extra.release_date || '2024-01-01',
    original_language: extra.original_language || 'en',
    poster_path: `/p${id}.jpg`,
  };
}

const core = loadCore();

test('detects media type and strips unknown fields from stored cards', () => {
  const compact = core.compactCard({
    id: 42,
    name: 'A show',
    first_air_date: '2024-01-01',
    genres: [{ id: 18, name: 'Drama' }],
    private_token: 'must-not-survive',
  });

  assert.equal(core.mediaType(compact), 'tv');
  assert.deepEqual(Array.from(compact.genre_ids), [18]);
  assert.equal(compact.private_token, undefined);
});

test('builds positive and negative taste signals only from plugin feedback', () => {
  const liked = movie(1, [878, 12], { title: 'Liked sci-fi' });
  const disliked = movie(2, [27], { title: 'Dropped horror' });
  const profile = core.buildProfileFromFeedback({
    schema: 1,
    items: {
      'movie:1': { value: 1, card: liked },
      'movie:2': { value: -1, card: disliked },
    },
  });

  assert.equal(profile.coldStart, false);
  assert.ok(profile.genreWeights.movie[878] > 0);
  assert.ok(profile.genreWeights.movie[27] < 0);
  assert.equal(profile.seen['movie:1'], true);
  assert.equal(profile.seen['movie:2'], true);
});

test('negative plugin feedback creates a negative taste signal', () => {
  const card = movie(5, [35]);
  const profile = core.buildProfileFromFeedback({
    schema: 1,
    items: {
      'movie:5': { value: -1, card },
    },
  });

  assert.ok(profile.negative.some((signal) => signal.key === 'movie:5'));
  assert.ok(profile.genreWeights.movie[35] < 0);
});

test('ranks candidates matching positive taste above disliked genres', () => {
  const liked = movie(1, [878]);
  const disliked = movie(2, [27]);
  const profile = core.buildProfileFromFeedback({
    schema: 1,
    items: {
      'movie:1': { value: 1, card: liked },
      'movie:2': { value: -1, card: disliked },
    },
  });

  const likedEntry = { key: 'movie:10', card: movie(10, [878]), sourceScore: 1, exploration: false };
  const dislikedEntry = { key: 'movie:11', card: movie(11, [27]), sourceScore: 1, exploration: false };

  const likedScore = core.scoreCandidate(likedEntry, profile, 'balanced', 1);
  const dislikedScore = core.scoreCandidate(dislikedEntry, profile, 'balanced', 1);
  assert.ok(likedScore > dislikedScore);
});

test('diversity selector does not mutate its input', () => {
  const entries = [
    { key: 'movie:1', card: movie(1, [18]), score: 0.9 },
    { key: 'movie:2', card: movie(2, [18]), score: 0.89 },
    { key: 'movie:3', card: movie(3, [35]), score: 0.86 },
  ];
  const original = entries.slice();
  const selected = core.selectDiverse(entries, 2, 'explore');

  assert.equal(selected.length, 2);
  assert.deepEqual(entries, original);
});

test('chooses an official trailer in the current language', () => {
  const selected = core.selectPreviewVideo([
    { key: 'clip', site: 'YouTube', type: 'Clip', iso_639_1: 'ru', official: true },
    { key: 'english', site: 'YouTube', type: 'Trailer', iso_639_1: 'en', official: true },
    { key: 'russian', site: 'YouTube', type: 'Trailer', iso_639_1: 'ru', official: true },
    { key: 'vimeo', site: 'Vimeo', type: 'Trailer', iso_639_1: 'ru', official: true },
  ], 'ru');

  assert.equal(selected.key, 'russian');
});

test('uses ordered trailer language fallbacks', () => {
  const selected = core.selectPreviewVideo([
    { key: 'english', site: 'YouTube', type: 'Trailer', iso_639_1: 'en', official: true },
    { key: 'russian', site: 'YouTube', type: 'Trailer', iso_639_1: 'ru', official: true },
  ], ['uk', 'ru', 'en']);

  assert.equal(selected.key, 'russian');
});

test('mood signals distinguish a quick skip from a watched preview', () => {
  assert.ok(core.moodSignalWeight('next', 2, true) < 0);
  assert.ok(core.moodSignalWeight('next', 25, true) < 0);
  assert.ok(core.moodSignalWeight('complete', 30, true) > 0);
  assert.ok(core.moodSignalWeight('like', 1, true) > 0);
  assert.ok(core.moodSignalWeight('watch', 3, true) > core.moodSignalWeight('complete', 30, true));
});

test('mood reranking reacts immediately to the last choices', () => {
  const drama = movie(21, [18]);
  const scienceFiction = movie(22, [878]);
  const ranked = core.rankMoodCards([drama, scienceFiction], [
    { card: movie(1, [878]), weight: 9 },
    { card: movie(2, [18]), weight: -4 },
  ], {});

  assert.equal(ranked[0].id, scienceFiction.id);
});
