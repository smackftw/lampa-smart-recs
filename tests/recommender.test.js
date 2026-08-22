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
  assert.equal(compact.title, 'A show');
  assert.deepEqual(Array.from(compact.genre_ids), [18]);
  assert.equal(compact.private_token, undefined);
});

test('separates live action, anime, and other animation', () => {
  assert.equal(core.contentKind(movie(1, [18])), 'movie');
  assert.equal(core.contentKind(movie(2, [16, 878], { original_language: 'ja' })), 'anime');
  assert.equal(core.contentKind(movie(3, [16, 35], { original_language: 'en' })), 'cartoon');
  assert.equal(core.contentKind(movie(4, [18], { media_type: 'tv' })), 'tv');
});

test('applies type, tri-state genre, and rating filters', () => {
  const filters = core.normalizeFilters({
    schema: 1,
    configured: true,
    types: { movie: true, tv: false, anime: false, cartoon: false },
    genres: { action: 1, horror: -1 },
    rating: 7,
  });

  assert.equal(core.matchesFilters(movie(10, [28], { vote_average: 7.4, vote_count: 500 }), filters), true);
  assert.equal(core.matchesFilters(movie(11, [28, 27], { vote_average: 8, vote_count: 500 }), filters), false);
  assert.equal(core.matchesFilters(movie(12, [28], { vote_average: 6.9, vote_count: 500 }), filters), false);
  assert.equal(core.matchesFilters(movie(13, [28], { media_type: 'tv', vote_average: 8, vote_count: 500 }), filters), false);
});

test('supports detective as a separate mystery filter', () => {
  const filters = core.normalizeFilters({
    schema: 1,
    configured: true,
    types: { movie: false, tv: true, anime: false, cartoon: false },
    genres: { detective: 1, thriller: -1, horror: -1 },
    rating: 0,
  });

  assert.equal(core.matchesFilters(movie(14, [9648], { media_type: 'tv' }), filters), true);
  assert.equal(core.matchesFilters(movie(15, [80], { media_type: 'tv' }), filters), false);
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
  assert.equal(profile.disliked['movie:1'], undefined);
  assert.equal(profile.disliked['movie:2'], true);
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

test('treats a movie or two distinct series episodes as completed playback', () => {
  assert.equal(core.timelineShowsCompleted({ percent: 89 }), false);
  assert.equal(core.timelineShowsCompleted({ percent: 90 }), true);
  assert.equal(core.timelineShowsCompleted([{ ep: 1, view: { percent: 95 } }]), false);
  assert.equal(core.timelineShowsCompleted([{ ep: 1, view: { percent: 95 } }, { ep: 2, view: { percent: 90 } }]), true);
  assert.equal(core.timelineShowsCompleted([{ ep: 1, view: { percent: 95 } }, { ep: 1, view: { percent: 95 } }]), false);
});

test('keeps content-specific taste alongside the broad profile', () => {
  const anime = movie(6, [16, 878], { original_language: 'ja' });
  const liveMovie = movie(7, [878], { original_language: 'en' });
  const profile = core.buildProfileFromFeedback({
    schema: 1,
    items: {
      anime: { value: 1, card: anime },
      movie: { value: -1, card: liveMovie },
    },
  });

  assert.ok(profile.kindGenreWeights.anime[878] > 0);
  assert.ok(profile.kindGenreWeights.movie[878] < 0);
  assert.equal(profile.kindSignalCounts.anime, 1);
  assert.equal(profile.kindSignalCounts.movie, 1);
  assert.ok(profile.kindWeights.anime > 0);
  assert.ok(profile.kindWeights.movie < 0);
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

test('balanced feed keeps a strong anime history from monopolizing all selected kinds', () => {
  const entries = [];
  for (let index = 0; index < 30; index += 1) {
    entries.push({
      key: `anime:${index}`,
      card: movie(1000 + index, [16, 878], { original_language: 'ja' }),
      score: 1 - index / 1000,
    });
  }
  for (let index = 0; index < 10; index += 1) {
    entries.push({ key: `movie:${index}`, card: movie(2000 + index, [878]), score: 0.62 - index / 1000 });
    entries.push({ key: `tv:${index}`, card: movie(3000 + index, [10765], { media_type: 'tv' }), score: 0.60 - index / 1000 });
  }

  const selected = core.selectDiverse(entries, 30, 'balanced', {
    initialKindUse: { anime: 10 },
    kindCount: 3,
    totalLimit: 40,
  });
  const counts = selected.reduce((result, entry) => {
    const kind = core.contentKind(entry.card);
    result[kind] = (result[kind] || 0) + 1;
    return result;
  }, {});

  assert.ok(counts.anime <= 14);
  assert.ok(counts.movie > 0);
  assert.ok(counts.tv > 0);
});

test('plans non-overlapping source pages for endless recommendation batches', () => {
  const first = core.recommendationBatchPlan(1);
  const second = core.recommendationBatchPlan(2);
  const third = core.recommendationBatchPlan(3);

  assert.equal(first.sourcePage, 1);
  assert.deepEqual(Array.from(first.discoveryPages), [1, 2]);
  assert.equal(second.sourcePage, 2);
  assert.deepEqual(Array.from(second.discoveryPages), [3, 4]);
  assert.deepEqual(Array.from(third.discoveryPages), [5, 6]);
});

test('removes repeated cards while extending the recommendation feed', () => {
  const known = { 'movie:1': true };
  const incoming = core.uniqueRecommendationCards([
    movie(1, [18]),
    movie(2, [35]),
    movie(2, [35]),
    movie(2, [35], { media_type: 'tv' }),
  ], known);

  assert.deepEqual(Array.from(incoming, (card) => core.cardKey(card)), ['movie:2', 'tv:2']);
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
  assert.ok(core.moodSignalWeight('next', 2, true) < core.moodSignalWeight('next', 25, true));
  assert.ok(core.moodSignalWeight('complete', 30, true) > 0);
  assert.equal(core.moodSignalWeight('like', 1, true), 6);
  assert.equal(core.moodSignalWeight('like', 7, true), 7);
  assert.equal(core.moodSignalWeight('like', 15, true), 8);
  assert.equal(core.moodSignalWeight('like', 25, true), 9);
  assert.equal(core.moodSignalWeight('like', 60, true), 9);
  assert.equal(core.trailerTasteWeight('like', 2, true), 6);
  assert.equal(core.trailerTasteWeight('like', 25, true), 9);
  assert.equal(core.moodSignalWeight('next', 60, true), core.moodSignalWeight('next', 25, true));
  assert.equal(core.moodSignalWeight('complete', 60, true), core.moodSignalWeight('complete', 30, true));
  assert.equal(core.moodSignalWeight('watch', 3, true), core.moodSignalWeight('complete', 30, true));
  assert.equal(core.moodSignalWeight('watch', 1, true), 4);
  assert.equal(core.trailerTasteWeight('watch', 1, true), 0);
});

test('trailer playback finishes nearby endings and caps long videos at sixty seconds', () => {
  assert.equal(core.previewClipDuration(22, 8), 14);
  assert.equal(core.previewClipDuration(68, 8), 60);
  assert.equal(core.previewClipDuration(78, 8), 70);
  assert.equal(core.previewClipDuration(79, 8), 60);
  assert.equal(core.previewClipDuration(120, 8), 60);
  assert.equal(core.previewClipDuration(18, 0), 18);
  assert.equal(core.previewClipDuration(0, 8), 30);
});

test('trailer reveal waits for clean playback without hiding short clips too long', () => {
  assert.equal(core.previewRevealDelay(120, 8), 3500);
  assert.equal(core.previewRevealDelay(18, 8), 1800);
  assert.equal(core.previewRevealDelay(2, 0), 700);
});

test('mood progress becomes complete at ten without presenting sixty as a goal', () => {
  const partial = core.moodProgressView(7, 0.5);
  assert.equal(partial.ready, false);
  assert.equal(partial.text, '7 / 10 · создаём настроение');
  assert.equal(partial.percent, 75);

  const ready = core.moodProgressView(10, 0);
  assert.equal(ready.ready, true);
  assert.equal(ready.text, '10 оценок · улучшаем ленту');
  assert.equal(ready.percent, 100);

  assert.equal(core.moodProgressView(24, 0.5).text, '24 оценки · улучшаем ленту');
  assert.equal(core.moodProgressView(21, 0).text, '21 оценка · улучшаем ленту');
  assert.equal(core.moodProgressView(60, 1).percent, 100);
});

test('reserves only a quarter of each feed batch for exact likes', () => {
  assert.equal(core.likedQuota(40, 1), 10);
  assert.equal(core.likedQuota(20, 2), 5);
  assert.equal(core.likedQuota(8, 1), 2);
});

test('guarantees exploration without letting it dominate precise mode', () => {
  assert.equal(core.explorationQuota(40, 'precise'), 2);
  assert.equal(core.explorationQuota(40, 'balanced'), 6);
  assert.equal(core.explorationQuota(40, 'explore'), 12);
});

test('movie genome distinguishes candidates inside the same broad genre', () => {
  const liked = movie(31, [18]);
  const profile = core.buildProfileFromFeedback({
    schema: 2,
    items: {
      liked: {
        value: 1,
        tasteWeight: 8,
        updatedAt: Date.now(),
        card: liked,
        genome: { features: [{ key: 'director:77', weight: 1.25 }, { key: 'keyword:99', weight: 1.15 }] },
      },
    },
  });
  const matching = movie(32, [18]);
  matching.smart_recs_genome = { features: [{ key: 'director:77', weight: 1.25 }] };
  const other = movie(33, [18]);
  other.smart_recs_genome = { features: [{ key: 'director:88', weight: 1.25 }] };

  assert.ok(core.affinityScore(matching, profile) > core.affinityScore(other, profile));
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

test('first ten mood trailers cover movies, series, and anime despite an anime-heavy prior score', () => {
  const filters = core.normalizeFilters({
    schema: 1,
    configured: true,
    types: { movie: true, tv: true, anime: true, cartoon: false },
    genres: { science_fiction: 1, action: 1, thriller: 1, detective: 1 },
    rating: 6,
  });
  const candidates = [];
  const movieGenres = [878, 28, 53, 9648];
  const tvGenres = [10765, 10759, 53, 9648];
  for (let index = 0; index < 16; index += 1) {
    const anime = movie(4000 + index, [16, movieGenres[index % movieGenres.length]], { original_language: 'ja' });
    anime.smart_recs_score = 99;
    candidates.push(anime);
  }
  for (let index = 0; index < 8; index += 1) {
    const liveMovie = movie(5000 + index, [movieGenres[index % movieGenres.length]]);
    liveMovie.smart_recs_score = 62;
    candidates.push(liveMovie);
    const series = movie(6000 + index, [tvGenres[index % tvGenres.length]], { media_type: 'tv' });
    series.smart_recs_score = 60;
    candidates.push(series);
  }

  const shown = {};
  const records = [];
  const sequence = [];
  const selectedCards = [];
  for (let index = 0; index < 10; index += 1) {
    const ranked = core.rankDiagnosticMoodCards(candidates, records, shown, filters);
    const selected = ranked[0];
    sequence.push(core.contentKind(selected));
    selectedCards.push(selected);
    shown[core.cardKey(selected)] = true;
    records.push({ card: selected, weight: 9 });
  }

  const counts = sequence.reduce((result, kind) => {
    result[kind] = (result[kind] || 0) + 1;
    return result;
  }, {});
  assert.equal(new Set(sequence.slice(0, 3)).size, 3);
  assert.ok(counts.anime <= 5);
  assert.ok(counts.movie >= 1);
  assert.ok(counts.tv >= 1);
  assert.equal(selectedCards.some((card) => card.genre_ids.includes(878) || card.genre_ids.includes(10765)), true);
  assert.equal(selectedCards.some((card) => card.genre_ids.includes(28) || card.genre_ids.includes(10759)), true);
  assert.equal(selectedCards.some((card) => card.genre_ids.includes(53)), true);
  assert.equal(selectedCards.some((card) => card.genre_ids.includes(9648)), true);
});
