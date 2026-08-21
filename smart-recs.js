/**
 * Lampa Smart Recs v0.4.0
 * Privacy-first personal recommendations without user API keys or a backend.
 * Install: https://smackftw.github.io/lampa-smart-recs/smart-recs.js
 */
(function () {
    'use strict';

    var pluginScript = typeof document !== 'undefined' ? document.currentScript : null;
    var pluginBaseUrl = pluginScript && pluginScript.src ? pluginScript.src.replace(/[^/]*(?:\?.*)?$/, '') : 'https://smackftw.github.io/lampa-smart-recs/';
    var TRAILER_PLAYER_URL = pluginBaseUrl + 'trailer-player.html';
    var VERSION = '0.4.0';
    var CACHE_SCHEMA = 1;
    var FEEDBACK_SCHEMA = 1;
    var MOOD_SCHEMA = 1;
    var FILTER_SCHEMA = 1;
    var MOOD_MINIMUM = 10;
    var MOOD_MAXIMUM = 60;
    var MOOD_TTL = 6 * 60 * 60 * 1000;
    var MOOD_DRAFT_TTL = 24 * 60 * 60 * 1000;
    var PREVIEW_SECONDS = 30;
    var INITIAL_RECOMMENDATION_LIMIT = 40;
    var MORE_RECOMMENDATION_LIMIT = 20;
    var LOAD_MORE_THRESHOLD = 8;
    var EMPTY_BATCH_RETRIES = 3;
    var PREFIX = 'lampa_smart_recs_';
    var COMPONENT = 'lampa_smart_recs';
    var MENU_CLASS = 'lampa-smart-recs-menu';
    var STYLE_ID = 'lampa-smart-recs-style';

    var CONTENT_TYPES = [
        { id: 'movie', title: 'Фильмы' },
        { id: 'tv', title: 'Сериалы' },
        { id: 'anime', title: 'Аниме' },
        { id: 'cartoon', title: 'Мультфильмы' }
    ];
    var FILTER_GENRES = [
        { id: 'science_fiction', title: 'Фантастика', movie: [878], tv: [10765] },
        { id: 'action', title: 'Боевик', movie: [28], tv: [10759] },
        { id: 'drama', title: 'Драма', movie: [18], tv: [18] },
        { id: 'romance', title: 'Мелодрама', movie: [10749], tv: [10766] },
        { id: 'thriller', title: 'Триллер', movie: [53], tv: [80] },
        { id: 'detective', title: 'Детектив', movie: [9648], tv: [9648] },
        { id: 'horror', title: 'Ужасы', movie: [27], tv: [9648] },
        { id: 'comedy', title: 'Комедия', movie: [35], tv: [35] }
    ];

    var runtime = {
        initialized: false,
        menuButton: null,
        inFlight: null,
        mood: null,
        moodLoading: false,
        filterPromptOpen: false,
        protectedFeatures: {},
        sessions: {}
    };

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function asArray(value) {
        return isArray(value) ? value : [];
    }

    function asNumber(value, fallback) {
        var number = Number(value);
        return isFinite(number) ? number : fallback;
    }

    function clamp(value, minimum, maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    function jsonClone(value) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
    }

    function mediaType(card) {
        if (!card) return 'movie';
        if (card.media_type === 'tv' || card.media_type === 'movie') return card.media_type;
        return card.name || card.original_name || card.first_air_date || card.number_of_seasons ? 'tv' : 'movie';
    }

    function cardKey(card) {
        if (!card || !card.id) return '';
        return mediaType(card) + ':' + String(card.id);
    }

    function recommendationBatchPlan(batch) {
        batch = Math.max(1, Math.floor(asNumber(batch, 1)));
        return {
            sourcePage: batch,
            discoveryPages: [batch * 2 - 1, batch * 2]
        };
    }

    function uniqueRecommendationCards(cards, known) {
        var result = [];
        known = known || {};
        asArray(cards).forEach(function (card) {
            var key = cardKey(card);
            if (!key || known[key]) return;
            known[key] = true;
            result.push(card);
        });
        return result;
    }

    function genreIds(card) {
        var result = [];
        var source = asArray(card && card.genre_ids).concat(asArray(card && card.genres));
        var used = {};

        source.forEach(function (genre) {
            var id = typeof genre === 'object' && genre ? genre.id : genre;
            id = asNumber(id, 0);
            if (id && !used[id]) {
                used[id] = true;
                result.push(id);
            }
        });

        return result;
    }

    function compactCard(card, fallbackType) {
        if (!card || !card.id) return null;

        var result = {
            id: asNumber(card.id, card.id),
            media_type: fallbackType || mediaType(card),
            title: card.title || '',
            name: card.name || '',
            original_title: card.original_title || '',
            original_name: card.original_name || '',
            overview: card.overview || '',
            vote_average: asNumber(card.vote_average, 0),
            vote_count: asNumber(card.vote_count, 0),
            popularity: asNumber(card.popularity, 0),
            release_date: card.release_date || '',
            first_air_date: card.first_air_date || '',
            poster_path: card.poster_path || '',
            backdrop_path: card.backdrop_path || '',
            genre_ids: genreIds(card),
            original_language: card.original_language || '',
            origin_country: asArray(card.origin_country).slice(0, 4),
            adult: card.adult === true,
            source: 'tmdb'
        };

        result.title = result.title || result.name || result.original_title || result.original_name || 'Без названия';
        if (result.media_type === 'tv' && !result.name) result.name = result.title;
        if (card.number_of_seasons) result.number_of_seasons = asNumber(card.number_of_seasons, 0);
        return result;
    }

    function contentKind(card) {
        var animated = genreIds(card).indexOf(16) >= 0;
        var japanese = card && card.original_language === 'ja' || asArray(card && card.origin_country).indexOf('JP') >= 0;
        if (animated && japanese) return 'anime';
        if (animated) return 'cartoon';
        return mediaType(card) === 'tv' ? 'tv' : 'movie';
    }

    function defaultFilters(configured) {
        return {
            schema: FILTER_SCHEMA,
            configured: configured === true,
            types: { movie: true, tv: true, anime: true, cartoon: true },
            genres: {
                science_fiction: 0,
                action: 0,
                drama: 0,
                romance: 0,
                thriller: 0,
                detective: 0,
                horror: 0,
                comedy: 0
            },
            rating: 0
        };
    }

    function normalizeFilters(value) {
        var result = defaultFilters(Boolean(value && value.configured));
        if (!value || value.schema !== FILTER_SCHEMA) return result;
        CONTENT_TYPES.forEach(function (type) {
            result.types[type.id] = Boolean(value.types && value.types[type.id]);
        });
        if (!CONTENT_TYPES.some(function (type) { return result.types[type.id]; })) {
            result.types = defaultFilters(false).types;
        }
        FILTER_GENRES.forEach(function (genre) {
            var state = asNumber(value.genres && value.genres[genre.id], 0);
            result.genres[genre.id] = state > 0 ? 1 : state < 0 ? -1 : 0;
        });
        result.rating = [0, 5, 6, 7, 8].indexOf(asNumber(value.rating, 0)) >= 0 ? asNumber(value.rating, 0) : 0;
        return result;
    }

    function filterGenreIds(filterGenre, type) {
        return asArray(filterGenre && filterGenre[type]);
    }

    function cardHasFilterGenre(card, filterGenre) {
        var ids = filterGenreIds(filterGenre, mediaType(card));
        var cardGenres = genreIds(card);
        return ids.some(function (id) { return cardGenres.indexOf(id) >= 0; });
    }

    function matchesFilters(card, filters) {
        filters = normalizeFilters(filters);
        if (!filters.types[contentKind(card)]) return false;
        if (filters.rating > 0) {
            if (asNumber(card && card.vote_average, 0) < filters.rating) return false;
            if (asNumber(card && card.vote_count, 0) < (mediaType(card) === 'movie' ? 100 : 50)) return false;
        }
        var wanted = FILTER_GENRES.filter(function (genre) { return filters.genres[genre.id] > 0; });
        var excluded = FILTER_GENRES.filter(function (genre) { return filters.genres[genre.id] < 0; });
        var type = mediaType(card);
        var wantedIds = [];
        wanted.forEach(function (genre) {
            filterGenreIds(genre, type).forEach(function (id) {
                if (wantedIds.indexOf(id) < 0) wantedIds.push(id);
            });
        });
        if (wanted.length && !wanted.some(function (genre) { return cardHasFilterGenre(card, genre); })) return false;
        if (excluded.some(function (genre) {
            return filterGenreIds(genre, type).some(function (id) {
                return wantedIds.indexOf(id) < 0 && genreIds(card).indexOf(id) >= 0;
            });
        })) return false;
        return true;
    }

    function filterSignature(filters) {
        filters = normalizeFilters(filters);
        return simpleHash(JSON.stringify({ types: filters.types, genres: filters.genres, rating: filters.rating }));
    }

    function titleOf(card) {
        return card && (card.title || card.name || card.original_title || card.original_name) || 'Без названия';
    }

    function yearOf(card) {
        var date = card && (card.release_date || card.first_air_date) || '';
        return asNumber(String(date).slice(0, 4), 0);
    }

    function simpleHash(text) {
        var hash = 2166136261;
        var index;
        for (index = 0; index < text.length; index++) {
            hash ^= text.charCodeAt(index);
            hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        }
        return (hash >>> 0).toString(36);
    }

    function selectPreviewVideo(videos, language) {
        var allowed = { Trailer: 3, Teaser: 2, Clip: 1 };
        var languages = isArray(language) ? language : [language || 'ru'];
        var selected = asArray(videos).filter(function (video) {
            return video && video.key && (!video.site || video.site === 'YouTube') && allowed[video.type];
        }).map(function (video, index) {
            var score = allowed[video.type] * 10;
            var languageIndex = languages.indexOf(video.iso_639_1);
            if (video.official) score += 8;
            if (languageIndex >= 0) score += Math.max(2, 8 - languageIndex * 3);
            if (video.size >= 720) score += 1;
            return { video: video, score: score, index: index };
        }).sort(function (left, right) {
            return right.score - left.score || left.index - right.index;
        });
        return selected.length ? selected[0].video : null;
    }

    function moodSignalWeight(action, watchedSeconds, hasVideo) {
        var seconds = Math.max(0, asNumber(watchedSeconds, 0));
        if (action === 'watch' || action === 'like') return 9;
        if (action === 'complete') return hasVideo === false ? 1.5 : 4;
        if (seconds >= 22) return -1.5;
        if (seconds >= 12) return -2;
        if (seconds >= 5) return -3;
        return hasVideo === false ? -2.5 : -4;
    }

    function buildMoodTaste(records) {
        var taste = { genres: {}, types: { movie: 0, tv: 0, anime: 0, cartoon: 0 }, maximum: 0 };
        asArray(records).forEach(function (record) {
            if (!record || !record.card) return;
            var weight = clamp(asNumber(record.weight, 0), -10, 10);
            taste.types[contentKind(record.card)] += weight;
            genreIds(record.card).forEach(function (genre) {
                taste.genres[genre] = (taste.genres[genre] || 0) + weight;
                taste.maximum = Math.max(taste.maximum, Math.abs(taste.genres[genre]));
            });
        });
        return taste;
    }

    function moodCardScore(card, taste) {
        var genres = genreIds(card);
        var affinity = 0;
        genres.forEach(function (genre) { affinity += taste.genres[genre] || 0; });
        if (genres.length && taste.maximum) affinity /= taste.maximum * Math.min(genres.length, 3);
        var base = clamp(asNumber(card && card.smart_recs_score, 50) / 100, 0, 1);
        var typeBias = clamp((taste.types[contentKind(card)] || 0) / 30, -1, 1);
        var jitter = (parseInt(simpleHash(cardKey(card)), 36) % 100) / 10000;
        return base * 0.36 + affinity * 0.50 + typeBias * 0.09 + qualityScore(card) * 0.05 + jitter;
    }

    function rankMoodCards(cards, records, excluded) {
        var taste = buildMoodTaste(records);
        excluded = excluded || {};
        return asArray(cards).filter(function (card) {
            return card && cardKey(card) && !excluded[cardKey(card)];
        }).slice().sort(function (left, right) {
            return moodCardScore(right, taste) - moodCardScore(left, taste);
        });
    }

    function normalizeMap(map) {
        var maximum = 0;
        var key;
        for (key in map) {
            if (Object.prototype.hasOwnProperty.call(map, key)) maximum = Math.max(maximum, Math.abs(map[key]));
        }
        if (!maximum) return map;
        for (key in map) {
            if (Object.prototype.hasOwnProperty.call(map, key)) map[key] = map[key] / maximum;
        }
        return map;
    }

    function buildProfileFromFeedback(feedback) {
        var signalMap = {};
        var seen = {};
        var genreWeights = { movie: {}, tv: {} };
        var kindGenreWeights = { movie: {}, tv: {}, anime: {}, cartoon: {} };
        var kindSignalCounts = { movie: 0, tv: 0, anime: 0, cartoon: 0 };
        var kindWeights = { movie: 0, tv: 0, anime: 0, cartoon: 0 };
        var languageWeights = {};

        function addSignal(card, weight, origin, order) {
            var safe = compactCard(card);
            var key = cardKey(safe);
            var signal;
            if (!key) return;

            signal = signalMap[key] || {
                key: key,
                card: safe,
                weight: 0,
                origins: [],
                order: order
            };
            if (genreIds(safe).length > genreIds(signal.card).length) signal.card = safe;
            signal.weight += weight;
            signal.order = Math.min(signal.order, order);
            signal.origins.push(origin);
            signalMap[key] = signal;
        }

        feedback = feedback && feedback.items || {};
        Object.keys(feedback).forEach(function (key) {
            var item = feedback[key];
            if (!item || !item.card) return;
            var weight = typeof item.weight === 'number' ? clamp(item.weight, -10, 10) : item.value > 0 ? 8 : -9;
            addSignal(item.card, weight, item.origin || (item.value > 0 ? 'manual_more' : 'manual_less'), 0);
            seen[cardKey(item.card)] = true;
        });

        var signals = Object.keys(signalMap).map(function (key) {
            var signal = signalMap[key];
            var type = mediaType(signal.card);
            var kind = contentKind(signal.card);
            var contribution = clamp(signal.weight, -10, 10);
            genreIds(signal.card).forEach(function (genre) {
                genreWeights[type][genre] = (genreWeights[type][genre] || 0) + contribution;
                kindGenreWeights[kind][genre] = (kindGenreWeights[kind][genre] || 0) + contribution;
            });
            kindSignalCounts[kind] += 1;
            kindWeights[kind] += contribution;
            signal.kind = kind;
            if (signal.card.original_language) {
                languageWeights[signal.card.original_language] = (languageWeights[signal.card.original_language] || 0) + contribution;
            }
            signal.weight = contribution;
            return signal;
        });

        normalizeMap(genreWeights.movie);
        normalizeMap(genreWeights.tv);
        CONTENT_TYPES.forEach(function (type) { normalizeMap(kindGenreWeights[type.id]); });
        normalizeMap(kindWeights);
        normalizeMap(languageWeights);

        signals.sort(function (left, right) {
            if (right.weight !== left.weight) return right.weight - left.weight;
            return left.order - right.order;
        });

        var positive = signals.filter(function (signal) { return signal.weight > 0.5; });
        var negative = signals.filter(function (signal) { return signal.weight < -0.5; });
        var signatureParts = signals.map(function (signal) {
            return signal.key + ':' + signal.weight.toFixed(2) + ':' + signal.origins.join(',');
        });

        return {
            signals: signals,
            positive: positive,
            negative: negative,
            seen: seen,
            genreWeights: genreWeights,
            kindGenreWeights: kindGenreWeights,
            kindSignalCounts: kindSignalCounts,
            kindWeights: kindWeights,
            languageWeights: languageWeights,
            signature: simpleHash(signatureParts.sort().join('|')),
            coldStart: positive.length === 0
        };
    }

    function qualityScore(card) {
        var rating = clamp(asNumber(card.vote_average, 0) / 10, 0, 1);
        var votes = Math.log(1 + Math.max(0, asNumber(card.vote_count, 0))) / Math.log(10001);
        return rating * clamp(votes, 0.2, 1);
    }

    function freshnessScore(card) {
        var year = yearOf(card);
        var current = new Date().getFullYear();
        if (!year) return 0.4;
        if (year >= current - 2) return 1;
        if (year >= current - 7) return 0.8;
        if (year >= current - 15) return 0.62;
        return 0.45;
    }

    function affinityScore(card, profile) {
        var weights = profile.genreWeights[mediaType(card)] || {};
        var kind = contentKind(card);
        var kindWeights = profile.kindGenreWeights && profile.kindGenreWeights[kind] || {};
        var confidence = clamp(asNumber(profile.kindSignalCounts && profile.kindSignalCounts[kind], 0) / 4, 0, 1);
        var genres = genreIds(card);
        var broad = 0;
        var specific = 0;
        if (!genres.length) return 0;
        genres.forEach(function (genre) {
            broad += weights[genre] || 0;
            specific += kindWeights[genre] || 0;
        });
        broad /= Math.max(1, Math.min(genres.length, 3));
        specific /= Math.max(1, Math.min(genres.length, 3));
        return clamp(broad * (1 - confidence * 0.65) + specific * confidence * 0.65, -1, 1);
    }

    function scoreCandidate(entry, profile, mode, maximumSource) {
        var weights = mode === 'precise'
            ? { source: 0.50, affinity: 0.30, quality: 0.17, fresh: 0.03, explore: 0 }
            : mode === 'explore'
                ? { source: 0.24, affinity: 0.20, quality: 0.28, fresh: 0.08, explore: 0.20 }
                : { source: 0.38, affinity: 0.29, quality: 0.23, fresh: 0.05, explore: 0.05 };
        var source = maximumSource ? clamp(entry.sourceScore / maximumSource, 0, 1) : 0;
        var affinity = affinityScore(entry.card, profile);
        var language = profile.languageWeights[entry.card.original_language] || 0;
        var kindPreference = profile.kindWeights && profile.kindWeights[contentKind(entry.card)] || 0;
        var exploration = entry.exploration ? 1 : 0;
        var deterministicJitter = (parseInt(simpleHash(entry.key + profile.signature), 36) % 100) / 10000;

        return weights.source * source
            + weights.affinity * ((affinity + 1) / 2)
            + weights.quality * qualityScore(entry.card)
            + weights.fresh * freshnessScore(entry.card)
            + weights.explore * exploration
            + 0.025 * Math.max(-1, language)
            + 0.04 * kindPreference
            + deterministicJitter;
    }

    function selectDiverse(entries, limit, mode) {
        var remaining = entries.slice();
        var selected = [];
        var genreUse = {};
        var typeUse = { movie: 0, tv: 0 };
        var penalty = mode === 'explore' ? 0.055 : 0.035;

        while (remaining.length && selected.length < limit) {
            var bestIndex = 0;
            var bestValue = -Infinity;
            remaining.forEach(function (entry, index) {
                var duplicatePenalty = 0;
                genreIds(entry.card).slice(0, 3).forEach(function (genre) {
                    duplicatePenalty += (genreUse[genre] || 0) * penalty;
                });
                duplicatePenalty += Math.max(0, typeUse[mediaType(entry.card)] - selected.length * 0.72) * 0.02;
                if (entry.score - duplicatePenalty > bestValue) {
                    bestValue = entry.score - duplicatePenalty;
                    bestIndex = index;
                }
            });

            var chosen = remaining.splice(bestIndex, 1)[0];
            selected.push(chosen);
            typeUse[mediaType(chosen.card)] += 1;
            genreIds(chosen.card).slice(0, 3).forEach(function (genre) {
                genreUse[genre] = (genreUse[genre] || 0) + 1;
            });
        }

        return selected;
    }

    var Core = {
        mediaType: mediaType,
        cardKey: cardKey,
        genreIds: genreIds,
        compactCard: compactCard,
        contentKind: contentKind,
        normalizeFilters: normalizeFilters,
        matchesFilters: matchesFilters,
        filterSignature: filterSignature,
        buildProfileFromFeedback: buildProfileFromFeedback,
        affinityScore: affinityScore,
        qualityScore: qualityScore,
        scoreCandidate: scoreCandidate,
        selectDiverse: selectDiverse,
        recommendationBatchPlan: recommendationBatchPlan,
        uniqueRecommendationCards: uniqueRecommendationCards,
        simpleHash: simpleHash,
        selectPreviewVideo: selectPreviewVideo,
        moodSignalWeight: moodSignalWeight,
        buildMoodTaste: buildMoodTaste,
        moodCardScore: moodCardScore,
        rankMoodCards: rankMoodCards
    };

    if (window.__LAMPA_SMART_RECS_TEST__) {
        window.LampaSmartRecsTest = Core;
        return;
    }

    function storageGet(name, fallback) {
        try {
            return Lampa.Storage.get(PREFIX + name, fallback);
        } catch (error) {
            return fallback;
        }
    }

    function storageSet(name, value) {
        try {
            Lampa.Storage.set(PREFIX + name, value);
        } catch (error) {
            console.warn('[SmartRecs] Storage write failed:', error);
        }
    }

    function setting(name, fallback) {
        try {
            var value = Lampa.Storage.field(PREFIX + name);
            return typeof value === 'undefined' || value === null ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function boolSetting(name, fallback) {
        var value = setting(name, fallback);
        return value === true || value === 'true' || value === 1 || value === '1';
    }

    function notify(message, error) {
        if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message, error ? { style: 'error', time: 5000 } : { time: 3500 });
        else console.log('[SmartRecs]', message);
    }

    function readFeedback() {
        var feedback = storageGet('feedback', { schema: FEEDBACK_SCHEMA, items: {} });
        if (!feedback || feedback.schema !== FEEDBACK_SCHEMA || !feedback.items) {
            feedback = { schema: FEEDBACK_SCHEMA, items: {} };
        }
        return feedback;
    }

    function emptyMoodStore() {
        return { schema: MOOD_SCHEMA, active: null, draft: null };
    }

    function readMoodStore() {
        var mood = storageGet('mood', emptyMoodStore());
        var changed = false;
        if (!mood || mood.schema !== MOOD_SCHEMA) mood = emptyMoodStore();
        if (mood.active && (!mood.active.expiresAt || mood.active.expiresAt <= Date.now())) {
            mood.active = null;
            changed = true;
        }
        if (mood.draft && (!mood.draft.updatedAt || Date.now() - mood.draft.updatedAt > MOOD_DRAFT_TTL)) {
            mood.draft = null;
            changed = true;
        }
        if (changed) storageSet('mood', mood);
        return mood;
    }

    function readFilters() {
        return normalizeFilters(storageGet('filters', defaultFilters(false)));
    }

    function saveFilters(filters) {
        var previous = readFilters();
        var next = normalizeFilters(filters);
        var changed = filterSignature(previous) !== filterSignature(next);
        next.configured = true;
        storageSet('filters', next);
        if (changed) {
            var mood = readMoodStore();
            mood.draft = null;
            storageSet('mood', mood);
            clearCache();
        }
        return changed;
    }

    function filterSummary(filters) {
        filters = normalizeFilters(filters);
        var selectedTypes = CONTENT_TYPES.filter(function (type) { return filters.types[type.id]; }).map(function (type) { return type.title; });
        var wanted = FILTER_GENRES.filter(function (genre) { return filters.genres[genre.id] > 0; }).map(function (genre) { return genre.title.toLowerCase(); });
        var excluded = FILTER_GENRES.filter(function (genre) { return filters.genres[genre.id] < 0; }).map(function (genre) { return genre.title.toLowerCase(); });
        var parts = [selectedTypes.length === CONTENT_TYPES.length ? 'Все типы' : selectedTypes.join(', ')];
        if (wanted.length) parts.push(wanted.join(', '));
        if (excluded.length) parts.push('без: ' + excluded.join(', '));
        parts.push(filters.rating ? filters.rating + '+' : 'любой рейтинг');
        return parts.join(' · ');
    }

    function learningFeedback() {
        var feedback = readFeedback();
        var combined = { schema: FEEDBACK_SCHEMA, items: {} };
        Object.keys(feedback.items).forEach(function (key) {
            combined.items[key] = feedback.items[key];
        });
        var active = readMoodStore().active;
        if (active) {
            asArray(active.records).forEach(function (record, index) {
                if (!record || !record.card) return;
                if (feedback.items[cardKey(record.card)]) return;
                combined.items['mood:' + index + ':' + cardKey(record.card)] = {
                    value: record.weight >= 0 ? 1 : -1,
                    weight: record.weight,
                    origin: 'current_mood',
                    card: record.card
                };
            });
        }
        return combined;
    }

    function setFeedback(card, value, quiet) {
        var safe = compactCard(card);
        var key = cardKey(safe);
        if (!key) return;
        var feedback = readFeedback();
        feedback.items[key] = {
            value: value > 0 ? 1 : -1,
            card: safe,
            updatedAt: Date.now()
        };
        storageSet('feedback', feedback);
        clearCache();
        if (!quiet) notify(value > 0 ? 'Нравится — лента обновится' : 'Не нравится — лента обновится');
    }

    function clearMood() {
        storageSet('mood', emptyMoodStore());
        clearCache();
        notify('Текущее настроение сброшено');
    }

    function clearAllRecommendations() {
        storageSet('feedback', { schema: FEEDBACK_SCHEMA, items: {} });
        storageSet('mood', emptyMoodStore());
        clearCache();
        notify('Все оценки удалены — рекомендации начнутся с нуля');
    }

    function confirmClearAllRecommendations() {
        var enabled = Lampa.Controller.enabled().name;
        Lampa.Select.show({
            title: 'Начать рекомендации с нуля?',
            items: [
                { title: 'Удалить все оценки', value: 'clear' },
                { title: 'Отмена', value: 'cancel' }
            ],
            onSelect: function (item) {
                if (item.value === 'clear') clearAllRecommendations();
                Lampa.Controller.toggle(enabled);
            },
            onBack: function () { Lampa.Controller.toggle(enabled); }
        });
    }

    function buildRuntimeProfile() {
        var profile = buildProfileFromFeedback(learningFeedback());
        profile.filters = readFilters();
        profile.signature = simpleHash([
            profile.signature,
            filterSignature(profile.filters),
            setting('mode', 'balanced'),
            boolSetting('hide_seen', true),
            readMoodStore().active ? readMoodStore().active.updatedAt : 0,
            VERSION
        ].join('|'));
        return profile;
    }

    function clearCache() {
        storageSet('cache', {});
    }

    function cacheLifetime() {
        return clamp(asNumber(setting('cache_hours', 12), 12), 1, 72) * 60 * 60 * 1000;
    }

    function readCache(profile) {
        var cache = storageGet('cache', {});
        if (!cache || cache.schema !== CACHE_SCHEMA || cache.signature !== profile.signature) return null;
        if (!cache.createdAt || Date.now() - cache.createdAt > cacheLifetime()) return null;
        return cache.payload || null;
    }

    function saveCache(profile, payload) {
        storageSet('cache', {
            schema: CACHE_SCHEMA,
            signature: profile.signature,
            createdAt: Date.now(),
            payload: payload
        });
    }

    function tmdbGet(method, params, callback) {
        var settled = false;
        function finish(result) {
            if (settled) return;
            settled = true;
            callback(result && result.results ? result.results : []);
        }
        try {
            Lampa.Api.sources.tmdb.get(method, params || {}, function (result) {
                finish(result);
            }, function () {
                finish(null);
            });
        } catch (error) {
            console.warn('[SmartRecs] TMDB request failed:', method, error);
            finish(null);
        }
    }

    function runQueue(tasks, concurrency, done) {
        var cursor = 0;
        var active = 0;
        var completed = 0;
        if (!tasks.length) return done();

        function next() {
            while (active < concurrency && cursor < tasks.length) {
                var task = tasks[cursor++];
                active += 1;
                task(function () {
                    active -= 1;
                    completed += 1;
                    if (completed >= tasks.length) done();
                    else next();
                });
            }
        }
        next();
    }

    function CandidatePool(profile) {
        this.profile = profile;
        this.items = {};
        this.anchors = {};
        this.maximumSource = 0;
    }

    CandidatePool.prototype.add = function (items, options) {
        var self = this;
        options = options || {};
        asArray(items).forEach(function (card, index) {
            var safe = compactCard(card, options.mediaType);
            var key = cardKey(safe);
            var entry;
            var positionWeight;
            if (!key || safe.adult) return;

            entry = self.items[key] || {
                key: key,
                card: safe,
                sourceScore: 0,
                exploration: false,
                reasons: []
            };
            if (genreIds(safe).length > genreIds(entry.card).length) entry.card = safe;
            positionWeight = Math.max(0.15, 1 - index / Math.max(20, items.length));
            entry.sourceScore += Math.max(0.1, asNumber(options.weight, 1)) * positionWeight;
            entry.exploration = entry.exploration || options.exploration === true;
            if (options.reason && entry.reasons.indexOf(options.reason) === -1) entry.reasons.push(options.reason);
            self.items[key] = entry;
            self.maximumSource = Math.max(self.maximumSource, entry.sourceScore);

            if (options.anchorKey) {
                if (!self.anchors[options.anchorKey]) self.anchors[options.anchorKey] = [];
                if (self.anchors[options.anchorKey].indexOf(key) === -1) self.anchors[options.anchorKey].push(key);
            }
        });
    };

    function topGenres(profile, type, limit) {
        var weights = profile.genreWeights[type] || {};
        return Object.keys(weights).filter(function (id) {
            return weights[id] > 0;
        }).sort(function (left, right) {
            return weights[right] - weights[left];
        }).slice(0, limit);
    }

    function mediaAllowed(filters, type) {
        filters = normalizeFilters(filters);
        return type === 'movie'
            ? filters.types.movie || filters.types.anime || filters.types.cartoon
            : filters.types.tv || filters.types.anime || filters.types.cartoon;
    }

    function positiveSignalsForFilters(profile) {
        var filters = normalizeFilters(profile.filters);
        var scoped = profile.positive.filter(function (signal) { return filters.types[contentKind(signal.card)]; });
        return scoped.length ? scoped : profile.positive;
    }

    function discoveryRequests(filters, page) {
        filters = normalizeFilters(filters);
        var requests = [];
        var wanted = FILTER_GENRES.filter(function (genre) { return filters.genres[genre.id] > 0; });
        var excluded = FILTER_GENRES.filter(function (genre) { return filters.genres[genre.id] < 0; });

        ['movie', 'tv'].forEach(function (media) {
            if (!mediaAllowed(filters, media)) return;
            var liveKind = media === 'movie' ? 'movie' : 'tv';
            var groups = [];
            if (filters.types[liveKind] && filters.types.anime && filters.types.cartoon) groups.push('all');
            else {
                if (filters.types[liveKind]) groups.push('live');
                if (filters.types.anime && filters.types.cartoon) groups.push('animation');
                else {
                    if (filters.types.anime) groups.push('anime');
                    if (filters.types.cartoon) groups.push('cartoon');
                }
            }

            groups.forEach(function (group) {
                var wantedIds = [];
                wanted.forEach(function (genre) {
                    filterGenreIds(genre, media).forEach(function (id) {
                        if (wantedIds.indexOf(id) < 0) wantedIds.push(id);
                    });
                });
                if (!wantedIds.length) wantedIds.push(0);

                wantedIds.forEach(function (wantedId) {
                    var genreIdsForRequest = [];
                    var withoutGenres = [];
                    if (group === 'live') withoutGenres.push(16);
                    if (group === 'animation' || group === 'anime' || group === 'cartoon') genreIdsForRequest.push(16);
                    if (wantedId && genreIdsForRequest.indexOf(wantedId) < 0) genreIdsForRequest.push(wantedId);
                    excluded.forEach(function (genre) {
                        filterGenreIds(genre, media).forEach(function (id) {
                            if (wantedIds.indexOf(id) < 0 && withoutGenres.indexOf(id) < 0) withoutGenres.push(id);
                        });
                    });

                    var request = {
                        mediaType: media,
                        kind: group,
                        params: {
                            page: page || 1,
                            genres: genreIdsForRequest.join(','),
                            sort_by: filters.rating ? 'vote_average.desc' : 'popularity.desc',
                            filter: {
                                'include_adult': 'false',
                                'vote_count.gte': media === 'movie' ? 100 : 50
                            }
                        }
                    };
                    if (!request.params.genres) delete request.params.genres;
                    if (withoutGenres.length) request.params.filter.without_genres = withoutGenres.join(',');
                    if (filters.rating) request.params.filter['vote_average.gte'] = filters.rating;
                    if (group === 'anime') request.params.orig_lang = 'ja';
                    requests.push(request);
                });
            });
        });

        return requests;
    }

    function addDiscoveryTasks(tasks, filters, pool, pages, weight) {
        asArray(pages).forEach(function (page) {
            discoveryRequests(filters, page).forEach(function (request) {
                tasks.push(function (done) {
                    tmdbGet('discover/' + request.mediaType, request.params, function (items) {
                        pool.add(items, {
                            mediaType: request.mediaType,
                            weight: weight || 1.7,
                            exploration: true,
                            reason: 'По текущим фильтрам'
                        });
                        done();
                    });
                });
            });
        });
    }

    function recommendationTasks(profile, pool, batch) {
        var tasks = [];
        var mode = setting('mode', 'balanced');
        var seedLimit = mode === 'precise' ? 8 : mode === 'explore' ? 4 : 6;
        var filters = normalizeFilters(profile.filters);
        var plan = recommendationBatchPlan(batch);

        positiveSignalsForFilters(profile).slice(0, seedLimit).forEach(function (signal) {
            var type = mediaType(signal.card);
            if (!mediaAllowed(filters, type)) return;
            var anchorKey = signal.key;
            var endpoint = type + '/' + signal.card.id + '/recommendations';
            tasks.push(function (done) {
                tmdbGet(endpoint, { page: plan.sourcePage }, function (items) {
                    if (items.length) {
                        pool.add(items, {
                            mediaType: type,
                            weight: Math.max(0.8, signal.weight),
                            anchorKey: anchorKey,
                            reason: 'Похоже на «' + titleOf(signal.card) + '»'
                        });
                        done();
                    } else {
                        tmdbGet(type + '/' + signal.card.id + '/similar', { page: plan.sourcePage }, function (similar) {
                            pool.add(similar, {
                                mediaType: type,
                                weight: Math.max(0.6, signal.weight * 0.8),
                                anchorKey: anchorKey,
                                reason: 'Похоже на «' + titleOf(signal.card) + '»'
                            });
                            done();
                        });
                    }
                });
            });
        });

        ['movie', 'tv'].forEach(function (type) {
            if (!mediaAllowed(filters, type)) return;
            var genres = topGenres(profile, type, 2);
            if (genres.length) {
                tasks.push(function (done) {
                    tmdbGet('discover/' + type, {
                        page: plan.sourcePage,
                        genres: genres.join(','),
                        sort_by: 'vote_average.desc',
                        filter: {
                            'include_adult': 'false',
                            'vote_count.gte': type === 'movie' ? 200 : 100
                        }
                    }, function (items) {
                        pool.add(items, {
                            mediaType: type,
                            weight: 2.4,
                            exploration: mode === 'explore',
                            reason: 'Ваши любимые жанры'
                        });
                        done();
                    });
                });
            }

            tasks.push(function (done) {
                tmdbGet('trending/' + type + '/week', { page: plan.sourcePage }, function (items) {
                    pool.add(items, {
                        mediaType: type,
                        weight: profile.coldStart ? 2.2 : 0.8,
                        exploration: true,
                        reason: 'Популярно сейчас'
                    });
                    done();
                });
            });
        });

        addDiscoveryTasks(tasks, filters, pool, plan.discoveryPages, 1.9);

        return tasks;
    }

    function finalizeCandidates(profile, pool, excluded, limit, batch) {
        var mode = setting('mode', 'balanced');
        var hideSeen = boolSetting('hide_seen', true);
        excluded = excluded || {};
        var entries = Object.keys(pool.items).map(function (key) {
            var entry = pool.items[key];
            entry.score = scoreCandidate(entry, profile, mode, pool.maximumSource);
            return entry;
        }).filter(function (entry) {
            if (!entry.card.poster_path && !entry.card.backdrop_path) return false;
            if (!matchesFilters(entry.card, profile.filters)) return false;
            if (hideSeen && profile.seen[entry.key]) return false;
            if (excluded[entry.key]) return false;
            return true;
        }).sort(function (left, right) {
            return right.score - left.score;
        });

        function cards(list) {
            return list.map(function (entry) {
                var card = jsonClone(entry.card);
                card.smart_recs_score = Math.round(entry.score * 100);
                card.smart_recs_reason = entry.reasons[0] || '';
                return card;
            });
        }

        var selected = selectDiverse(entries, limit || INITIAL_RECOMMENDATION_LIMIT, mode);
        var lines = [];
        if (selected.length) {
            lines.push({
                title: 'Для вас',
                results: cards(selected),
                nomore: true
            });
        }

        return {
            lines: lines,
            meta: {
                generatedAt: Date.now(),
                signals: profile.signals.length,
                candidates: entries.length,
                coldStart: profile.coldStart,
                batch: Math.max(1, asNumber(batch, 1))
            }
        };
    }

    function generateRecommendationBatch(profile, batch, excluded, limit, callback) {
        var pool = new CandidatePool(profile);
        runQueue(recommendationTasks(profile, pool, batch), 3, function () {
            callback(finalizeCandidates(profile, pool, excluded, limit, batch));
        });
    }

    function generateRecommendations(profile, callback) {
        generateRecommendationBatch(profile, 1, {}, INITIAL_RECOMMENDATION_LIMIT, callback);
    }

    function getRecommendations(force, callback) {
        var profile = buildRuntimeProfile();
        var cached = force ? null : readCache(profile);
        if (cached) return setTimeout(function () { callback(jsonClone(cached)); }, 0);

        if (runtime.inFlight && runtime.inFlight.signature === profile.signature) {
            runtime.inFlight.callbacks.push(callback);
            return;
        }

        var flight = { signature: profile.signature, callbacks: [callback] };
        runtime.inFlight = flight;
        generateRecommendations(profile, function (payload) {
            var waiting = flight.callbacks.slice();
            if (runtime.inFlight === flight) {
                saveCache(profile, payload);
                runtime.inFlight = null;
            }
            waiting.forEach(function (done) { done(jsonClone(payload)); });
        });
    }

    function interfaceVideoLanguages() {
        var language = 'ru';
        try { language = Lampa.Storage.get('language', 'ru') || 'ru'; } catch (error) {}
        language = String(language).toLowerCase().split(/[-_]/)[0];
        var result = [language];
        var russianFallback = ['uk', 'be', 'kk', 'ky', 'uz', 'tg', 'hy', 'az', 'ka'];
        if (language !== 'ru' && russianFallback.indexOf(language) >= 0) result.push('ru');
        if (result.indexOf('en') < 0) result.push('en');
        return result;
    }

    function tmdbVideos(card, languages, callback) {
        var type = mediaType(card);
        var collected = [];
        var cursor = 0;
        function next() {
            if (cursor >= languages.length) return callback(collected);
            var language = languages[cursor++];
            tmdbGet(type + '/' + card.id + '/videos', { langs: language }, function (items) {
                collected = collected.concat(items);
                var exact = items.filter(function (video) { return video && video.iso_639_1 === language; });
                if (selectPreviewVideo(exact, [language])) callback(collected);
                else next();
            });
        }
        next();
    }

    function cardsFromLines(lines) {
        var cards = [];
        var used = {};
        asArray(lines).forEach(function (line) {
            asArray(line && line.results).forEach(function (card) {
                var safe = compactCard(card);
                var key = cardKey(safe);
                if (!key || used[key]) return;
                safe.smart_recs_score = asNumber(card.smart_recs_score, 50);
                safe.smart_recs_reason = card.smart_recs_reason || '';
                used[key] = true;
                cards.push(safe);
            });
        });
        return cards;
    }

    function prepareMoodCandidates(payload, profile, callback) {
        var cards = cardsFromLines(payload && payload.lines);
        var used = {};
        var filters = normalizeFilters(profile.filters);
        cards.forEach(function (card) { used[cardKey(card)] = true; });

        function add(items, type) {
            asArray(items).forEach(function (card) {
                var safe = compactCard(card, type);
                var key = cardKey(safe);
                if (!key || used[key] || safe.adult || (!safe.poster_path && !safe.backdrop_path) || profile.seen[key] || !matchesFilters(safe, filters)) return;
                safe.smart_recs_score = 45;
                used[key] = true;
                cards.push(safe);
            });
        }

        var tasks = [];
        ['movie', 'tv'].forEach(function (type) {
            if (!mediaAllowed(filters, type)) return;
            [2, 3].forEach(function (page) {
                tasks.push(function (done) {
                    tmdbGet('trending/' + type + '/week', { page: page }, function (items) {
                        add(items, type);
                        done();
                    });
                });
            });
            var genres = topGenres(profile, type, 3);
            if (genres.length) {
                tasks.push(function (done) {
                    tmdbGet('discover/' + type, {
                        page: 1,
                        genres: genres.join(','),
                        sort_by: 'popularity.desc',
                        filter: { 'include_adult': 'false' }
                    }, function (items) {
                        add(items, type);
                        done();
                    });
                });
            }
        });

        [2, 3].forEach(function (page) {
            discoveryRequests(filters, page).forEach(function (request) {
                tasks.push(function (done) {
                    tmdbGet('discover/' + request.mediaType, request.params, function (items) {
                        add(items, request.mediaType);
                        done();
                    });
                });
            });
        });

        runQueue(tasks, 3, function () { callback(cards); });
    }

    function addStyles() {
        if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.setAttribute('data-smart-recs-version', VERSION);
        style.textContent = [
            '.smart-recs-mood-entry{width:20em;height:8.5em;border-radius:1.1em;overflow:hidden;background:linear-gradient(135deg,#e8eee9,#b9c8bd);color:#152019;display:flex;align-items:flex-end;position:relative;padding:1.25em;box-sizing:border-box}',
            '.smart-recs-mood-entry:after{content:"";position:absolute;inset:0;background:radial-gradient(circle at 82% 16%,rgba(255,255,255,.75),transparent 34%)}',
            '.smart-recs-mood-entry__icon{position:absolute;right:1.1em;top:1em;width:4.2em;height:4.2em;opacity:.82}',
            '.smart-recs-mood-entry__text{position:relative;z-index:1}.smart-recs-mood-entry__title{font-size:1.35em;font-weight:650;margin-bottom:.35em}.smart-recs-mood-entry__subtitle{font-size:.86em;opacity:.72;max-width:18em}',
            '.smart-recs-mood-entry.focus{box-shadow:0 0 0 .22em #fff,0 .8em 2.4em rgba(0,0,0,.28);transform:scale(1.025)}',
            '.smart-recs-filter-entry{width:20em;height:8.5em;border-radius:1.1em;overflow:hidden;background:linear-gradient(135deg,#dfe5ee,#aebdce);color:#17202a;display:flex;align-items:flex-end;position:relative;padding:1.25em;box-sizing:border-box}',
            '.smart-recs-filter-entry:after{content:"";position:absolute;right:1.4em;top:1.2em;width:4.3em;height:4.3em;border:.22em solid currentColor;border-radius:50%;opacity:.16}',
            '.smart-recs-filter-entry__text{position:relative;z-index:1}.smart-recs-filter-entry__title{font-size:1.35em;font-weight:650;margin-bottom:.35em}.smart-recs-filter-entry__subtitle{font-size:.82em;line-height:1.35;opacity:.72;max-width:21em}',
            '.smart-recs-filter-entry.focus{box-shadow:0 0 0 .22em #fff,0 .8em 2.4em rgba(0,0,0,.28);transform:scale(1.025)}',
            '.smart-recs-screen{height:100%}.smart-recs-page{padding:1.1em 0 3em}.smart-recs-page__heading{font-size:1.45em;font-weight:600;margin:0 1em .8em}',
            '.smart-recs-actions-row{display:flex;flex-wrap:wrap;gap:1em;padding:0 1.4em 2.2em}.smart-recs-grid{align-items:flex-start}.smart-recs-grid .card{padding-bottom:1.8em}',
            '.smart-recs-grid .card__title{display:-webkit-box!important;-webkit-box-orient:vertical;-webkit-line-clamp:3!important;line-clamp:3!important;height:auto!important;min-height:2.4em;max-height:3.6em;overflow:hidden;overflow-wrap:anywhere;word-break:break-word}',
            '.smart-recs-filter-editor{padding:.3em .1em 1em}.smart-recs-filter-editor__section{margin-bottom:1.4em}.smart-recs-filter-editor__heading{font-size:1em;font-weight:650;margin-bottom:.65em}.smart-recs-filter-editor__chips{display:flex;flex-wrap:wrap;gap:.55em}',
            '.smart-recs-filter-chip{padding:.62em .9em;border-radius:.65em;background:rgba(255,255,255,.09);border:.12em solid rgba(255,255,255,.12);min-width:6.5em;text-align:center;box-sizing:border-box}.smart-recs-filter-chip.is-selected,.smart-recs-filter-chip.is-wanted{background:#dce8df;color:#172019;border-color:#dce8df}.smart-recs-filter-chip.is-excluded{background:#653e43;color:#fff0f0;border-color:#8b545b}.smart-recs-filter-chip.focus{box-shadow:0 0 0 .18em #fff;transform:scale(1.035)}',
            '.smart-recs-filter-editor__legend{font-size:.82em;opacity:.65;line-height:1.45}',
            '.smart-recs-mood{position:fixed;inset:0;z-index:999;background:#0b0e0c;color:#f4f6f4;overflow:hidden;font-family:inherit}',
            '.smart-recs-mood__media{position:absolute;inset:0;background:#111 center/cover no-repeat}.smart-recs-mood__media iframe{width:100%;height:100%;border:0;display:block;opacity:0;transition:opacity .35s ease}.smart-recs-mood__media iframe.ready{opacity:1}',
            '.smart-recs-mood__shade{position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(6,8,7,.28) 0%,transparent 34%,rgba(6,8,7,.9) 86%,#080a09 100%)}',
            '.smart-recs-mood__top{position:absolute;left:4.2em;right:4.2em;top:2.6em;display:flex;align-items:center;gap:1.2em}.smart-recs-mood__counter{font-size:.9em;letter-spacing:.06em;white-space:nowrap;opacity:.85}',
            '.smart-recs-mood__track{height:.28em;background:rgba(255,255,255,.22);border-radius:1em;overflow:hidden;flex:1}.smart-recs-mood__track span{display:block;width:0;height:100%;background:#edf5ef;transition:width .15s linear}',
            '.smart-recs-mood__bottom{position:absolute;left:4.2em;right:4.2em;bottom:3.3em;display:flex;align-items:flex-end;justify-content:space-between;gap:3em}',
            '.smart-recs-mood__info{max-width:57%;text-shadow:0 .12em .35em rgba(0,0,0,.8)}.smart-recs-mood__eyebrow{font-size:.82em;letter-spacing:.09em;text-transform:uppercase;opacity:.66;margin-bottom:.6em}.smart-recs-mood__title{font-size:2.1em;line-height:1.08;font-weight:650}.smart-recs-mood__overview{font-size:.9em;line-height:1.45;opacity:.76;margin-top:.75em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
            '.smart-recs-mood__actions{display:flex;gap:.8em;flex-shrink:0}.smart-recs-mood__button{min-width:8.8em;padding:.88em 1.35em;border-radius:.72em;background:rgba(238,243,239,.15);border:.12em solid rgba(255,255,255,.26);font-size:1.05em;text-align:center;box-sizing:border-box}.smart-recs-mood__button.focus{background:#eef3ef;color:#101612;border-color:#eef3ef;transform:scale(1.045)}',
            '.smart-recs-mood__button--next.focus{background:#b9c9bd;border-color:#b9c9bd}.smart-recs-mood__status{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:.75em 1em;border-radius:.6em;background:rgba(0,0,0,.58);font-size:.9em}.smart-recs-mood__status.hide{display:none}',
            '@media(max-width:700px){.smart-recs-actions-row{display:grid;grid-template-columns:1fr 1fr}.smart-recs-filter-entry,.smart-recs-mood-entry{width:100%}.smart-recs-mood__top{left:1.4em;right:1.4em;top:1.3em}.smart-recs-mood__bottom{left:1.4em;right:1.4em;bottom:1.5em;display:block}.smart-recs-mood__info{max-width:100%}.smart-recs-mood__overview{display:none}.smart-recs-mood__actions{margin-top:1.2em}.smart-recs-mood__button{flex:1}.smart-recs-mood__title{font-size:1.55em}}'
        ].join('');
        document.head.appendChild(style);
    }

    function moodStatusText() {
        var mood = readMoodStore();
        if (mood.draft && asArray(mood.draft.records).length < MOOD_MINIMUM) {
            return 'Продолжить: ' + mood.draft.records.length + ' из ' + MOOD_MINIMUM;
        }
        if (mood.active) return 'Обновить выбор · действует 6 часов';
        return '10–60 коротких трейлеров';
    }

    function FilterEntryCard(data) {
        var html;
        var card = {};
        card.create = function () {
            html = $('<div class="smart-recs-filter-entry selector"><div class="smart-recs-filter-entry__text"><div class="smart-recs-filter-entry__title">Изменить подборку</div><div class="smart-recs-filter-entry__subtitle"></div></div></div>');
            html.find('.smart-recs-filter-entry__subtitle').text(filterSummary(readFilters()));
            html.on('hover:focus hover:hover hover:touch', function () {
                if (card.onFocus) card.onFocus(html[0], data);
            });
            html.on('hover:enter', function () {
                if (card.onEnter) card.onEnter(html[0], data);
            });
        };
        card.render = function (js) { return js ? html[0] : html; };
        card.destroy = function () { if (html) html.remove(); };
        return card;
    }

    function MoodEntryCard(data) {
        var html;
        var card = {};
        card.create = function () {
            html = $('<div class="smart-recs-mood-entry selector">' +
                '<svg class="smart-recs-mood-entry__icon" viewBox="0 0 64 64"><path fill="currentColor" d="M32 6a26 26 0 1 0 0 52 26 26 0 0 0 0-52Zm-9 15 22 11-22 11V21Z"/></svg>' +
                '<div class="smart-recs-mood-entry__text"><div class="smart-recs-mood-entry__title">Лента трейлеров</div><div class="smart-recs-mood-entry__subtitle"></div></div></div>');
            html.find('.smart-recs-mood-entry__subtitle').text(moodStatusText());
            html.on('hover:focus hover:hover hover:touch', function () {
                if (card.onFocus) card.onFocus(html[0], data);
            });
            html.on('hover:enter', function () {
                if (card.onEnter) card.onEnter(html[0], data);
            });
        };
        card.render = function (js) { return js ? html[0] : html; };
        card.destroy = function () { if (html) html.remove(); };
        return card;
    }

    function RecommendationActionCard(data) {
        return data && data.smart_recs_action === 'filters' ? FilterEntryCard(data) : MoodEntryCard(data);
    }

    function imageForCard(card) {
        var path = card && (card.backdrop_path || card.poster_path);
        if (!path || !Lampa.TMDB || !Lampa.TMDB.image) return '';
        return Lampa.TMDB.image('t/p/w1280' + path);
    }

    function newMoodSession() {
        var now = Date.now();
        return {
            id: simpleHash(String(now) + ':' + Math.random()),
            createdAt: now,
            updatedAt: now,
            expiresAt: now + MOOD_TTL,
            records: [],
            presented: []
        };
    }

    function MoodSession(cards) {
        var self = this;
        var store = readMoodStore();
        var session = store.draft || newMoodSession();
        var html = $('<div class="smart-recs-mood">' +
            '<div class="smart-recs-mood__media"></div><div class="smart-recs-mood__shade"></div>' +
            '<div class="smart-recs-mood__top"><div class="smart-recs-mood__counter"></div><div class="smart-recs-mood__track"><span></span></div></div>' +
            '<div class="smart-recs-mood__status">Загружаем трейлер…</div>' +
            '<div class="smart-recs-mood__bottom"><div class="smart-recs-mood__info"><div class="smart-recs-mood__eyebrow"></div><div class="smart-recs-mood__title"></div><div class="smart-recs-mood__overview"></div></div>' +
            '<div class="smart-recs-mood__actions"><div class="smart-recs-mood__button smart-recs-mood__button--watch selector">Смотреть</div><div class="smart-recs-mood__button smart-recs-mood__button--next selector">Дальше</div></div></div></div>');
        var media = html.find('.smart-recs-mood__media');
        var watchButton = html.find('.smart-recs-mood__button--watch');
        var nextButton = html.find('.smart-recs-mood__button--next');
        var current = null;
        var currentVideo = null;
        var frame = null;
        var frameWindow = null;
        var bridgeId = '';
        var clipStart = 0;
        var watchedSeconds = 0;
        var shownAt = 0;
        var playbackTimer = null;
        var playbackRetries = 0;
        var playerSequence = 0;
        var ignorePlayback = true;
        var serial = 0;
        var changing = false;
        var destroyed = false;
        var videoCache = {};
        var shown = {};

        asArray(session.records).forEach(function (record) { shown[cardKey(record.card)] = true; });
        asArray(session.presented).forEach(function (key) { shown[key] = true; });

        function count() { return asArray(session.records).length; }

        function updateProgress() {
            var amount = count();
            var target = amount < MOOD_MINIMUM ? MOOD_MINIMUM : MOOD_MAXIMUM;
            html.find('.smart-recs-mood__counter').text(amount < MOOD_MINIMUM ? amount + ' / ' + MOOD_MINIMUM + ' · минимум' : amount + ' / ' + MOOD_MAXIMUM + ' · настроение готово');
            var actionProgress = currentVideo ? clamp(watchedSeconds / PREVIEW_SECONDS, 0, 1) : 0;
            var total = clamp((amount + actionProgress) / target * 100, 0, 100);
            html.find('.smart-recs-mood__track span').css('width', total + '%');
        }

        function saveSession(complete) {
            session.updatedAt = Date.now();
            session.expiresAt = Date.now() + MOOD_TTL;
            store.draft = complete ? null : jsonClone(session);
            if (count() >= MOOD_MINIMUM) store.active = jsonClone(session);
            storageSet('mood', store);
        }

        function post(type, data) {
            try {
                if (frameWindow) frameWindow.postMessage({ bridgeId: bridgeId, type: type, data: data || {} }, '*');
            } catch (error) {}
        }

        function destroyFrame() {
            clearTimeout(playbackTimer);
            playbackRetries = 0;
            if (frame) post('destroy');
            if (frame) frame.remove();
            frame = null;
            frameWindow = null;
            bridgeId = '';
            currentVideo = null;
            ignorePlayback = true;
        }

        function prepareFrameForNext() {
            clearTimeout(playbackTimer);
            playbackRetries = 0;
            ignorePlayback = true;
            currentVideo = null;
            if (frame) {
                post('pause');
                frame.classList.remove('ready');
            }
        }

        function loadVideo(card, callback) {
            var key = cardKey(card);
            if (Object.prototype.hasOwnProperty.call(videoCache, key)) return callback(videoCache[key]);
            var languages = interfaceVideoLanguages();
            tmdbVideos(card, languages, function (videos) {
                videoCache[key] = selectPreviewVideo(videos, languages);
                callback(videoCache[key]);
            });
        }

        function createFrame(video) {
            clipStart = video.type === 'Teaser' ? 0 : 8;
            playerSequence += 1;
            ignorePlayback = false;
            playbackRetries = 0;
            if (!frame) {
                bridgeId = 'smart_recs_' + Math.random().toString(36).slice(2);
                frame = document.createElement('iframe');
                frame.src = TRAILER_PLAYER_URL + '?v=' + encodeURIComponent(VERSION) + '&bridgeId=' + encodeURIComponent(bridgeId) + '&videoId=' + encodeURIComponent(video.key) + '&autoplay=1&start=' + clipStart + '&sequence=' + playerSequence;
                frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
                frame.setAttribute('allowfullscreen', 'true');
                frame.onload = function () { if (frame) frameWindow = frame.contentWindow; };
                media.empty().append(frame);
                frameWindow = frame.contentWindow;
            } else {
                post('load', { videoId: video.key, start: clipStart, autoplay: true, sequence: playerSequence });
                playbackTimer = setTimeout(retryAutoplay, 350);
            }
        }

        function previewNext() {
            var ranked = rankMoodCards(cards, session.records, shown);
            ranked.slice(0, 4).forEach(function (card) { loadVideo(card, function () {}); });
        }

        function retryAutoplay() {
            clearTimeout(playbackTimer);
            if (!frame || frame.classList.contains('ready')) return;
            if (playbackRetries >= 10) {
                html.find('.smart-recs-mood__status').removeClass('hide').text('Не удалось запустить трейлер · нажмите Дальше');
                return;
            }
            playbackRetries += 1;
            post('play');
            playbackTimer = setTimeout(retryAutoplay, 1200);
        }

        function showNext() {
            if (destroyed) return;
            changing = false;
            prepareFrameForNext();
            var ranked = rankMoodCards(cards, session.records, shown);
            if (!ranked.length) return self.finish(true);
            current = ranked[0];
            shown[cardKey(current)] = true;
            session.presented = asArray(session.presented);
            session.presented.push(cardKey(current));
            session.presented = session.presented.slice(-MOOD_MAXIMUM * 2);
            saveSession(false);
            watchedSeconds = 0;
            shownAt = Date.now();
            serial += 1;
            var requestSerial = serial;
            var backdrop = imageForCard(current);
            media.css('background-image', backdrop ? 'url("' + backdrop.replace(/"/g, '%22') + '")' : 'none');
            html.find('.smart-recs-mood__title').text(titleOf(current));
            html.find('.smart-recs-mood__overview').text(current.overview || 'Оцените по трейлеру, постеру и описанию.');
            html.find('.smart-recs-mood__eyebrow').text((mediaType(current) === 'tv' ? 'Сериал' : 'Фильм') + (yearOf(current) ? ' · ' + yearOf(current) : ''));
            html.find('.smart-recs-mood__status').removeClass('hide').text('Загружаем трейлер…');
            updateProgress();
            loadVideo(current, function (video) {
                if (destroyed || requestSerial !== serial) return;
                currentVideo = video;
                if (video) createFrame(video);
                else html.find('.smart-recs-mood__status').removeClass('hide').text('Трейлер не найден · оцените карточку');
                previewNext();
            });
        }

        function actualWatched() {
            if (currentVideo) return watchedSeconds;
            return Math.max(0, (Date.now() - shownAt) / 1000);
        }

        function record(action) {
            var watched = actualWatched();
            session.records = asArray(session.records);
            session.records.push({
                card: compactCard(current),
                action: action,
                watched: Math.round(watched * 10) / 10,
                weight: moodSignalWeight(action, watched, Boolean(currentVideo)),
                updatedAt: Date.now()
            });
            if (action === 'next') setFeedback(current, -1, true);
            if (action === 'like' || action === 'watch') setFeedback(current, 1, true);
            saveSession(false);
            if (count() === MOOD_MINIMUM) clearCache();
            updateProgress();
        }

        function act(action) {
            if (changing || !current) return;
            changing = true;
            record(action);
            if (action === 'watch') {
                var card = current;
                self.destroy();
                Lampa.Activity.push({
                    url: '', component: 'full', id: card.id, method: mediaType(card), card: card, source: 'tmdb'
                });
                return;
            }
            if (count() >= MOOD_MAXIMUM) return self.finish(true);
            showNext();
        }

        function openMoodTasteMenu() {
            if (changing || !current) return;
            post('pause');
            Lampa.Select.show({
                title: 'Оценить трейлер',
                items: [
                    { title: 'Нравится', action: 'like' },
                    { title: 'Не нравится', action: 'next' }
                ],
                onSelect: function (item) {
                    Lampa.Controller.toggle('smart_recs_mood');
                    act(item.action);
                },
                onBack: function () {
                    Lampa.Controller.toggle('smart_recs_mood');
                    post('play');
                }
            });
        }

        function onMessage(event) {
            if (!event.data || event.data.bridgeId !== bridgeId || destroyed) return;
            var type = event.data.type;
            var data = event.data.data || {};
            if (typeof data.sequence === 'number' && data.sequence !== playerSequence) return;
            if (ignorePlayback && type !== 'bridgeReady') return;
            if (type === 'bridgeReady' || type === 'ready') {
                frameWindow = frame && frame.contentWindow;
                post('init', { volume: 100 });
                post('play');
                if (type === 'ready') retryAutoplay();
            } else if (type === 'stateChange' && data.state === 1) {
                clearTimeout(playbackTimer);
                playbackRetries = 0;
                if (frame) frame.classList.add('ready');
                html.find('.smart-recs-mood__status').addClass('hide');
            } else if (type === 'time') {
                watchedSeconds = Math.max(watchedSeconds, asNumber(data.currentTime, clipStart) - clipStart);
                updateProgress();
                if (watchedSeconds >= PREVIEW_SECONDS) act('complete');
            } else if (type === 'stateChange' && data.state === 0 && frame && frame.classList.contains('ready')) {
                act('complete');
            } else if (type === 'error') {
                clearTimeout(playbackTimer);
                if (frame) frame.classList.remove('ready');
                ignorePlayback = true;
                currentVideo = null;
                html.find('.smart-recs-mood__status').removeClass('hide').text('Трейлер недоступен · оцените карточку');
            }
            if (Lampa.Screensaver && Lampa.Screensaver.resetTimer) Lampa.Screensaver.resetTimer();
        }

        this.start = function () {
            $('body').addClass('ambience--enable').append(html);
            if (Lampa.Background && Lampa.Background.theme) Lampa.Background.theme('black');
            window.addEventListener('message', onMessage);
            watchButton.on('hover:enter', function () { act('watch'); });
            nextButton.on('hover:enter', function () { act('next'); });
            Lampa.Controller.add('smart_recs_mood', {
                link: self,
                toggle: function () {
                    Lampa.Controller.collectionSet(html);
                    Lampa.Controller.collectionFocus(nextButton, html);
                },
                left: function () { Lampa.Controller.focus(watchButton[0]); },
                right: function () { act('next'); },
                long: openMoodTasteMenu,
                back: function () { self.finish(false); }
            });
            Lampa.Controller.toggle('smart_recs_mood');
            showNext();
        };

        this.finish = function (automatic) {
            if (destroyed) return;
            var ready = count() >= MOOD_MINIMUM;
            saveSession(ready);
            if (ready) clearCache();
            self.destroy();
            if (ready) {
                notify('Настроение учтено · ' + count() + ' оценок');
                Lampa.Activity.replace({ force: true });
            } else {
                notify('Черновик сохранён · ещё ' + (MOOD_MINIMUM - count()) + '');
                Lampa.Controller.toggle('content');
            }
        };

        this.destroy = function () {
            if (destroyed) return;
            destroyed = true;
            serial += 1;
            destroyFrame();
            window.removeEventListener('message', onMessage);
            html.remove();
            $('body').removeClass('ambience--enable');
            if (Lampa.Background && Lampa.Background.theme) Lampa.Background.theme('reset');
            runtime.mood = null;
        };
    }

    function startMoodCalibration() {
        if (runtime.mood || runtime.moodLoading) return;
        runtime.moodLoading = true;
        notify('Готовим короткие трейлеры…');
        var profile = buildRuntimeProfile();
        getRecommendations(false, function (payload) {
            prepareMoodCandidates(payload, profile, function (cards) {
                runtime.moodLoading = false;
                if (!cards.length) return notify('Не удалось собрать фильмы для настройки', true);
                runtime.mood = new MoodSession(cards);
                runtime.mood.start();
            });
        });
    }

    function buildFilterEditor(draft) {
        var html = $('<div class="smart-recs-filter-editor"></div>');

        function section(title, items, kind) {
            var block = $('<div class="smart-recs-filter-editor__section"><div class="smart-recs-filter-editor__heading"></div><div class="smart-recs-filter-editor__chips"></div></div>');
            block.find('.smart-recs-filter-editor__heading').text(title);
            items.forEach(function (item) {
                var chip = $('<div class="smart-recs-filter-chip selector"></div>');
                chip.attr('data-filter-kind', kind).attr('data-filter-id', item.id).attr('data-filter-title', item.title).text(item.title);
                block.find('.smart-recs-filter-editor__chips').append(chip);
            });
            html.append(block);
        }

        section('Что показывать', CONTENT_TYPES, 'type');
        section('Жанры · OK меняет: хочу → исключить → неважно', FILTER_GENRES, 'genre');
        section('Рейтинг не ниже', [
            { id: '0', title: 'Любой' },
            { id: '5', title: '5+' },
            { id: '6', title: '6+' },
            { id: '7', title: '7+' },
            { id: '8', title: '8+' }
        ], 'rating');
        html.append('<div class="smart-recs-filter-editor__legend">Фильтр определяет, что показать сейчас, и не меняет ваш постоянный вкус.</div>');
        syncFilterEditor(html, draft);
        return html;
    }

    function syncFilterEditor(html, draft) {
        html.find('.smart-recs-filter-chip').each(function () {
            var chip = $(this);
            var kind = chip.attr('data-filter-kind');
            var id = chip.attr('data-filter-id');
            var title = chip.attr('data-filter-title');
            var state = 0;
            if (kind === 'type') state = draft.types[id] ? 1 : 0;
            else if (kind === 'genre') state = asNumber(draft.genres[id], 0);
            else if (kind === 'rating') state = asNumber(id, 0) === asNumber(draft.rating, 0) ? 1 : 0;
            chip.toggleClass('is-selected', kind !== 'genre' && state > 0);
            chip.toggleClass('is-wanted', kind === 'genre' && state > 0);
            chip.toggleClass('is-excluded', kind === 'genre' && state < 0);
            chip.text((state > 0 ? '✓ ' : state < 0 ? '× ' : '') + title);
        });
    }

    function openFilterEditor(onApply) {
        if (runtime.filterPromptOpen) return;
        runtime.filterPromptOpen = true;
        var previousController = Lampa.Controller.enabled().name;
        var draft = jsonClone(readFilters());
        var html = buildFilterEditor(draft);

        function close() {
            runtime.filterPromptOpen = false;
            Lampa.Modal.close();
            Lampa.Controller.toggle(previousController);
        }

        Lampa.Modal.open({
            title: 'Что показать сейчас',
            html: html,
            size: 'large',
            align: 'center',
            buttons: [
                {
                    name: 'Сбросить фильтры',
                    onSelect: function () {
                        draft = defaultFilters(true);
                        syncFilterEditor(html, draft);
                    }
                },
                {
                    name: 'Показать',
                    onSelect: function () {
                        var hasType = CONTENT_TYPES.some(function (type) { return draft.types[type.id]; });
                        if (!hasType) return notify('Выберите хотя бы один тип контента', true);
                        var changed = saveFilters(draft);
                        close();
                        if (onApply) onApply(changed);
                    }
                }
            ],
            onSelect: function (chip) {
                var kind = chip.attr('data-filter-kind');
                var id = chip.attr('data-filter-id');
                if (kind === 'type') draft.types[id] = !draft.types[id];
                else if (kind === 'genre') {
                    var state = asNumber(draft.genres[id], 0);
                    draft.genres[id] = state === 0 ? 1 : state > 0 ? -1 : 0;
                } else if (kind === 'rating') draft.rating = asNumber(id, 0);
                syncFilterEditor(html, draft);
            },
            onBack: close
        });
    }

    function editCurrentFilters() {
        openFilterEditor(function (changed) {
            if (changed) Lampa.Activity.replace({ force: true });
        });
    }

    function openRecommendationAction(target, data) {
        if (data && data.smart_recs_action === 'filters') editCurrentFilters();
        else startMoodCalibration();
    }

    function openTasteMenu(target, card) {
        var enabled = Lampa.Controller.enabled().name;
        Lampa.Select.show({
            title: 'Оценить рекомендацию',
            items: [
                { title: 'Нравится', value: 1 },
                { title: 'Не нравится', value: -1 }
            ],
            onSelect: function (item) {
                setFeedback(card, item.value);
                Lampa.Controller.toggle(enabled);
            },
            onBack: function () { Lampa.Controller.toggle(enabled); }
        });
    }

    function refresh() {
        clearCache();
        getRecommendations(true, function (payload) {
            notify(payload.lines.length ? 'Рекомендации обновлены' : 'Не удалось получить рекомендации', !payload.lines.length);
        });
    }

    function RecommendationsComponent(object) {
        object = object || {};
        var component = {};
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250, end_ratio: 2 });
        var html = document.createElement('div');
        var page = document.createElement('div');
        var actions = document.createElement('div');
        var grid = document.createElement('div');
        var items = [];
        var recommendationData = [];
        var active = 0;
        var last = null;
        var alive = true;
        var feedKnown = {};
        var nextBatch = 2;
        var loadingMore = false;
        var emptyBatches = 0;
        var feedExhausted = false;
        var built = false;

        html.className = 'smart-recs-screen';
        page.className = 'smart-recs-page';
        actions.className = 'smart-recs-actions-row';
        grid.className = 'category-full smart-recs-grid';

        function heading(title) {
            var element = document.createElement('div');
            element.className = 'smart-recs-page__heading';
            element.textContent = title;
            return element;
        }

        page.appendChild(heading('Настройка рекомендаций'));
        page.appendChild(actions);
        page.appendChild(heading('Для вас'));
        page.appendChild(grid);

        function navigator() {
            return window.Navigator || null;
        }

        function focusItem(item, target, data, recommendation) {
            last = target;
            active = items.indexOf(item);
            scroll.update(item.render(true));
            if (recommendation && Lampa.Background && Lampa.Background.change && Lampa.Utils && Lampa.Utils.cardImgBackground) {
                Lampa.Background.change(Lampa.Utils.cardImgBackground(data));
            }
            if (recommendation) maybeLoadMore(data);
        }

        function appendAction(data) {
            var item = RecommendationActionCard(data);
            item.create();
            item.onFocus = function (target, card) { focusItem(item, target, card, false); };
            item.onEnter = openRecommendationAction;
            actions.appendChild(item.render(true));
            items.push(item);
        }

        function appendRecommendation(card, append) {
            var item = new Lampa.Card(card, { object: object, card_category: true });
            item.create();
            item.onFocus = function (target, data) { focusItem(item, target, data, true); };
            item.onTouch = function (target, data) { focusItem(item, target, data, true); };
            item.onHover = function (target, data) { focusItem(item, target, data, true); };
            item.onEnter = function (target, data) {
                last = target;
                Lampa.Activity.push({
                    url: '',
                    component: 'full',
                    id: data.id,
                    method: mediaType(data),
                    card: data,
                    source: 'tmdb'
                });
            };
            item.onMenu = openTasteMenu;
            grid.appendChild(item.render(true));
            items.push(item);
            recommendationData.push(card);
            if (append && Lampa.Controller.own && Lampa.Controller.own(component)) {
                Lampa.Controller.collectionAppend(item.render(true));
            }
        }

        function limitVisible() {
            if (!items.length) return;
            var nearby = items.slice(Math.max(0, active - 12), active + 13);
            items.forEach(function (item) {
                item.render(true).classList.toggle('layer--render', nearby.indexOf(item) >= 0);
            });
            var navigation = navigator();
            if (navigation && navigation.setCollection) {
                navigation.setCollection(items.slice(Math.max(0, active - 36), active + 37).map(function (item) { return item.render(true); }));
                if (navigation.focused) navigation.focused(last);
            }
            if (Lampa.Layer && Lampa.Layer.visible) Lampa.Layer.visible(scroll.render(true));
        }

        function requestNextBatch() {
            if (!alive || loadingMore || feedExhausted || !built) return;
            loadingMore = true;
            var batch = nextBatch++;
            var profile = buildRuntimeProfile();
            generateRecommendationBatch(profile, batch, feedKnown, MORE_RECOMMENDATION_LIMIT, function (payload) {
                if (!alive) return;
                loadingMore = false;
                var line = payload && payload.lines && payload.lines[0];
                var incoming = uniqueRecommendationCards(line && line.results, feedKnown);
                if (!incoming.length) {
                    emptyBatches += 1;
                    if (emptyBatches >= EMPTY_BATCH_RETRIES) feedExhausted = true;
                    else setTimeout(requestNextBatch, 0);
                    return;
                }
                emptyBatches = 0;
                incoming.forEach(function (card) { appendRecommendation(card, true); });
                limitVisible();
            });
        }

        function maybeLoadMore(card) {
            var index = recommendationData.indexOf(card);
            if (index < 0) {
                var key = cardKey(card);
                index = recommendationData.map(cardKey).indexOf(key);
            }
            if (index >= recommendationData.length - LOAD_MORE_THRESHOLD) requestNextBatch();
        }

        component.create = function () {
            if (component.activity && component.activity.loader) component.activity.loader(true);
            getRecommendations(object.force === true, function (payload) {
                if (!alive) return;
                appendAction({ id: 'filter-selection', media_type: 'movie', smart_recs_action: 'filters' });
                appendAction({ id: 'mood-calibration', media_type: 'movie', smart_recs_action: 'mood' });
                var initial = payload && payload.lines && payload.lines[0] ? payload.lines[0].results : [];
                uniqueRecommendationCards(initial, feedKnown).forEach(function (card) { appendRecommendation(card, false); });
                scroll.minus();
                scroll.onEnd = requestNextBatch;
                scroll.onScroll = limitVisible;
                scroll.onWheel = function (step) {
                    if (Lampa.Controller.own && !Lampa.Controller.own(component)) component.start();
                    var navigation = navigator();
                    if (navigation && navigation.move) navigation.move(step > 0 ? 'down' : 'up');
                };
                scroll.append(page);
                html.appendChild(scroll.render(true));
                built = true;
                limitVisible();
                if (component.activity && component.activity.loader) component.activity.loader(false);
                if (component.activity && component.activity.toggle) component.activity.toggle();
                if (!readFilters().configured) {
                    setTimeout(function () {
                        if (alive) openFilterEditor(function (changed) {
                            if (changed) Lampa.Activity.replace({ force: true });
                        });
                    }, 150);
                }
            });
            return component.render();
        };

        component.start = function () {
            Lampa.Controller.add('content', {
                link: component,
                toggle: function () {
                    if (component.activity && component.activity.canRefresh && component.activity.canRefresh()) return false;
                    Lampa.Controller.collectionSet(scroll.render(true));
                    Lampa.Controller.collectionFocus(last || false, scroll.render(true));
                },
                left: function () {
                    var navigation = navigator();
                    if (navigation && navigation.canmove && navigation.canmove('left')) navigation.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                right: function () {
                    var navigation = navigator();
                    if (navigation && navigation.move) navigation.move('right');
                },
                up: function () {
                    var navigation = navigator();
                    if (navigation && navigation.canmove && navigation.canmove('up')) navigation.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () {
                    var navigation = navigator();
                    if (navigation && navigation.canmove && navigation.canmove('down')) navigation.move('down');
                    else requestNextBatch();
                },
                back: function () { Lampa.Activity.backward(); }
            });
            Lampa.Controller.toggle('content');
        };

        component.refresh = function () {
            if (component.activity && component.activity.needRefresh) component.activity.needRefresh();
        };

        component.pause = function () {};
        component.stop = function () {};

        component.render = function (js) {
            return js ? html : $(html);
        };

        component.destroy = function () {
            alive = false;
            items.forEach(function (item) { if (item && item.destroy) item.destroy(); });
            if (scroll && scroll.destroy) scroll.destroy();
            if (html && html.remove) html.remove();
            items = [];
            recommendationData = [];
        };

        return component;
    }

    function openRecommendations(force) {
        Lampa.Activity.push({
            url: '',
            title: 'Рекомендации',
            component: COMPONENT,
            source: 'tmdb',
            page: 1,
            force: force === true
        });
    }

    function menuIcon() {
        return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="M12 2l2.3 5.1L20 8l-4 4 1 5.7-5-2.7-5 2.7L8 12 4 8l5.7-.9L12 2z" fill="currentColor"/>' +
            '<path d="M19 15v6M16 18h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
            '</svg>';
    }

    function updateMenu() {
        var enabled = boolSetting('enabled', true);
        if (!runtime.menuButton) {
            runtime.menuButton = $('<li class="menu__item selector ' + MENU_CLASS + '">' +
                '<div class="menu__ico">' + menuIcon() + '</div>' +
                '<div class="menu__text">Рекомендации</div></li>');
            runtime.menuButton.on('hover:enter', function () { openRecommendations(false); });
        }
        if (!enabled) return runtime.menuButton.detach();
        if ($('.' + MENU_CLASS).length) return;

        var menu = $('.menu .menu__list').eq(0);
        if (menu.length) menu.prepend(runtime.menuButton);
        else setTimeout(updateMenu, 500);
    }

    function registerSettings() {
        Lampa.SettingsApi.addComponent({
            component: COMPONENT,
            name: 'Рекомендации',
            icon: menuIcon()
        });

        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'enabled', type: 'trigger', default: true },
            field: { name: 'Включить плагин', description: 'Показывать раздел «Рекомендации» в боковом меню.' },
            onChange: updateMenu
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'home_row', type: 'trigger', default: true },
            field: { name: 'Строка на главной', description: 'Добавлять персональную подборку на главный экран Lampa.' }
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: {
                name: PREFIX + 'mode',
                type: 'select',
                values: { precise: 'Точнее по вкусу', balanced: 'Сбалансированно', explore: 'Больше нового' },
                default: 'balanced'
            },
            field: { name: 'Режим подбора' },
            onChange: clearCache
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'hide_seen', type: 'trigger', default: true },
            field: { name: 'Скрывать уже оценённое' },
            onChange: clearCache
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: {
                name: PREFIX + 'cache_hours',
                type: 'select',
                values: { 3: '3 часа', 6: '6 часов', 12: '12 часов', 24: '24 часа' },
                default: '12'
            },
            field: { name: 'Обновлять не реже' },
            onChange: clearCache
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'refresh', type: 'button' },
            field: { name: 'Обновить рекомендации сейчас' },
            onChange: refresh
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'clear_mood', type: 'button' },
            field: { name: 'Сбросить текущее настроение', description: 'Удалить только временную сессию трейлеров. Постоянный вкус сохранится.' },
            onChange: clearMood
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'clear_all', type: 'button' },
            field: { name: 'Начать рекомендации с нуля', description: 'Удалить все оценки и текущее настроение.' },
            onChange: confirmClearAllRecommendations
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'privacy', type: 'static' },
            field: {
                name: 'Приватность · версия ' + VERSION,
                description: 'Оценки и профиль никуда не загружаются. ID опорных фильмов запрашиваются через встроенный TMDB-клиент Lampa.'
            }
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'protected', type: 'static' },
            field: {
                name: 'Защищённые функции',
                description: 'Будущие AI-функции используют серверную проверку кода и временный токен. Секреты не хранятся в плагине.'
            }
        });
    }

    function registerHomeRow() {
        if (!Lampa.ContentRows || !Lampa.ContentRows.add) return;
        Lampa.ContentRows.add({
            name: 'smart_recs_for_you',
            title: 'Для вас',
            index: 1,
            screen: ['main'],
            call: function () {
                if (!boolSetting('enabled', true) || !boolSetting('home_row', true)) return;
                return function (done) {
                    getRecommendations(false, function (payload) {
                        done(payload.lines.length ? jsonClone(payload.lines[0]) : undefined);
                    });
                };
            }
        });
    }

    function gatewayRequest(url, method, token, body, callback) {
        var request = new XMLHttpRequest();
        request.open(method, url, true);
        request.timeout = 15000;
        request.setRequestHeader('Content-Type', 'application/json');
        if (token) request.setRequestHeader('Authorization', 'Bearer ' + token);
        request.onload = function () {
            var data = {};
            try { data = JSON.parse(request.responseText || '{}'); } catch (error) {}
            callback(request.status >= 200 && request.status < 300 ? null : new Error(data.message || 'HTTP ' + request.status), data);
        };
        request.onerror = function () { callback(new Error('network_error')); };
        request.ontimeout = function () { callback(new Error('timeout')); };
        request.send(body ? JSON.stringify(body) : null);
    }

    function registerProtectedFeature(feature) {
        if (!feature || !feature.id || !feature.title || !feature.gatewayUrl || typeof feature.run !== 'function') {
            throw new Error('Protected feature requires id, title, gatewayUrl and run()');
        }
        runtime.protectedFeatures[feature.id] = feature;
    }

    function runProtectedFeature(id, context) {
        var feature = runtime.protectedFeatures[id];
        if (!feature) return notify('Защищённая функция не зарегистрирована', true);
        var session = runtime.sessions[id];

        function launch(activeSession) {
            feature.run({
                context: context || {},
                token: activeSession.token,
                request: function (path, method, body, callback) {
                    gatewayRequest(feature.gatewayUrl.replace(/\/$/, '') + path, method || 'POST', activeSession.token, body, callback);
                }
            });
        }

        if (session && session.expiresAt > Date.now() + 30000) return launch(session);
        if (!Lampa.Input || !Lampa.Input.edit) return notify('Ввод кода недоступен в этой версии Lampa', true);

        Lampa.Input.edit({
            title: 'Код доступа: ' + feature.title,
            free: true,
            nosave: true,
            nomic: true,
            value: ''
        }, function (code) {
            if (!code) return;
            gatewayRequest(feature.gatewayUrl.replace(/\/$/, '') + '/v1/session', 'POST', '', {
                feature: id,
                access_code: code,
                client: 'lampa-smart-recs',
                version: VERSION
            }, function (error, data) {
                if (error || !data.token) return notify('Неверный код или шлюз недоступен', true);
                runtime.sessions[id] = {
                    token: data.token,
                    expiresAt: Date.now() + clamp(asNumber(data.expires_in, 900), 60, 3600) * 1000
                };
                launch(runtime.sessions[id]);
            });
        });
    }

    function init() {
        if (runtime.initialized) return;
        runtime.initialized = true;
        addStyles();
        Lampa.Component.add(COMPONENT, RecommendationsComponent);
        registerSettings();
        registerHomeRow();
        updateMenu();

        setTimeout(function () {
            if (boolSetting('enabled', true)) getRecommendations(false, function () {});
        }, 2500);

        console.log('[SmartRecs] Ready v' + VERSION + '; local profile, no user API keys');
    }

    window.LampaSmartRecs = {
        version: VERSION,
        open: openRecommendations,
        calibrate: startMoodCalibration,
        refresh: refresh,
        clearMood: clearMood,
        resetAll: clearAllRecommendations,
        registerProtectedFeature: registerProtectedFeature,
        runProtectedFeature: runProtectedFeature
    };

    if (window.lampa_smart_recs_ready) return;
    window.lampa_smart_recs_ready = true;

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (event) {
        if (event.type === 'ready') init();
    });
})();
