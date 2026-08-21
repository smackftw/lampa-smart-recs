/**
 * Lampa Smart Recs v0.1.0
 * Privacy-first personal recommendations without user API keys or a backend.
 * Install: https://smackftw.github.io/lampa-smart-recs/smart-recs.js
 */
(function () {
    'use strict';

    var VERSION = '0.1.0';
    var CACHE_SCHEMA = 1;
    var FEEDBACK_SCHEMA = 1;
    var PREFIX = 'lampa_smart_recs_';
    var COMPONENT = 'lampa_smart_recs';
    var MENU_CLASS = 'lampa-smart-recs-menu';

    var CATEGORY_WEIGHTS = {
        like: 6,
        viewed: 5,
        look: 3,
        continued: 2.5,
        book: 2,
        wath: 2,
        scheduled: 1.5,
        history: 1.2,
        thrown: -7
    };

    var runtime = {
        initialized: false,
        menuButton: null,
        inFlight: null,
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
            adult: card.adult === true,
            source: 'tmdb'
        };

        if (result.media_type === 'tv' && !result.name) result.name = result.title;
        if (result.media_type === 'movie' && !result.title) result.title = result.name;
        if (card.number_of_seasons) result.number_of_seasons = asNumber(card.number_of_seasons, 0);
        return result;
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

    function progressAdjustment(type, card, progressResolver) {
        if (type !== 'history' || typeof progressResolver !== 'function') return 0;
        var progress;
        try {
            progress = asNumber(progressResolver(card), 0);
        } catch (error) {
            progress = 0;
        }

        if (mediaType(card) === 'tv') return progress > 0 ? Math.min(2, progress * 0.25) : 0;
        if (progress >= 85) return 3;
        if (progress >= 55) return 1.5;
        if (progress >= 10 && progress <= 40) return -1.5;
        return 0;
    }

    function buildProfileFromData(lists, feedback, progressResolver) {
        var signalMap = {};
        var seen = {};
        var genreWeights = { movie: {}, tv: {} };
        var languageWeights = {};
        var types = Object.keys(CATEGORY_WEIGHTS);

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

        types.forEach(function (type) {
            asArray(lists[type]).forEach(function (card, index) {
                var recency = Math.max(0, 0.35 - index * 0.012);
                var weight = CATEGORY_WEIGHTS[type];
                weight += weight >= 0 ? recency : -recency;
                weight += progressAdjustment(type, card, progressResolver);
                addSignal(card, weight, type, index);

                if (type === 'history' || type === 'viewed' || type === 'like' || type === 'thrown') {
                    seen[cardKey(card)] = true;
                }
            });
        });

        feedback = feedback && feedback.items || {};
        Object.keys(feedback).forEach(function (key) {
            var item = feedback[key];
            if (!item || !item.card) return;
            addSignal(item.card, item.value > 0 ? 8 : -9, item.value > 0 ? 'manual_more' : 'manual_less', 0);
            seen[cardKey(item.card)] = true;
        });

        var signals = Object.keys(signalMap).map(function (key) {
            var signal = signalMap[key];
            var type = mediaType(signal.card);
            var contribution = clamp(signal.weight, -10, 10);
            genreIds(signal.card).forEach(function (genre) {
                genreWeights[type][genre] = (genreWeights[type][genre] || 0) + contribution;
            });
            if (signal.card.original_language) {
                languageWeights[signal.card.original_language] = (languageWeights[signal.card.original_language] || 0) + contribution;
            }
            signal.weight = contribution;
            return signal;
        });

        normalizeMap(genreWeights.movie);
        normalizeMap(genreWeights.tv);
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
        var genres = genreIds(card);
        var sum = 0;
        if (!genres.length) return 0;
        genres.forEach(function (genre) { sum += weights[genre] || 0; });
        return clamp(sum / Math.max(1, Math.min(genres.length, 3)), -1, 1);
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
        var exploration = entry.exploration ? 1 : 0;
        var deterministicJitter = (parseInt(simpleHash(entry.key + profile.signature), 36) % 100) / 10000;

        return weights.source * source
            + weights.affinity * ((affinity + 1) / 2)
            + weights.quality * qualityScore(entry.card)
            + weights.fresh * freshnessScore(entry.card)
            + weights.explore * exploration
            + 0.025 * Math.max(-1, language)
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
        buildProfileFromData: buildProfileFromData,
        affinityScore: affinityScore,
        qualityScore: qualityScore,
        scoreCandidate: scoreCandidate,
        selectDiverse: selectDiverse,
        simpleHash: simpleHash
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

    function setFeedback(card, value) {
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
        notify(value > 0 ? 'Учту: показывать больше похожего' : 'Учту: показывать меньше похожего');
    }

    function clearFeedback() {
        storageSet('feedback', { schema: FEEDBACK_SCHEMA, items: {} });
        clearCache();
        notify('Локальные оценки рекомендаций очищены');
    }

    function favoriteList(type) {
        try {
            return asArray(Lampa.Favorite.get({ type: type }));
        } catch (error) {
            return [];
        }
    }

    function buildRuntimeProfile() {
        var lists = {};
        Object.keys(CATEGORY_WEIGHTS).forEach(function (type) {
            lists[type] = favoriteList(type);
        });
        var profile = buildProfileFromData(lists, readFeedback(), function (card) {
            if (!Lampa.Timeline || !Lampa.Timeline.watched) return 0;
            return Lampa.Timeline.watched(card, false);
        });
        profile.signature = simpleHash([
            profile.signature,
            setting('mode', 'balanced'),
            boolSetting('hide_seen', true),
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

    function nativeRecommendations(pool) {
        if (!Lampa.Recomends || !Lampa.Recomends.get) return;
        try {
            pool.add(Lampa.Recomends.get('movie'), { mediaType: 'movie', weight: 1.1, reason: 'Lampa' });
            pool.add(Lampa.Recomends.get('tv'), { mediaType: 'tv', weight: 1.1, reason: 'Lampa' });
        } catch (error) {
            console.warn('[SmartRecs] Native recommendations unavailable:', error);
        }
    }

    function topGenres(profile, type, limit) {
        var weights = profile.genreWeights[type] || {};
        return Object.keys(weights).filter(function (id) {
            return weights[id] > 0;
        }).sort(function (left, right) {
            return weights[right] - weights[left];
        }).slice(0, limit);
    }

    function recommendationTasks(profile, pool) {
        var tasks = [];
        var mode = setting('mode', 'balanced');
        var seedLimit = mode === 'precise' ? 8 : mode === 'explore' ? 4 : 6;

        profile.positive.slice(0, seedLimit).forEach(function (signal) {
            var type = mediaType(signal.card);
            var anchorKey = signal.key;
            var endpoint = type + '/' + signal.card.id + '/recommendations';
            tasks.push(function (done) {
                tmdbGet(endpoint, {}, function (items) {
                    if (items.length) {
                        pool.add(items, {
                            mediaType: type,
                            weight: Math.max(0.8, signal.weight),
                            anchorKey: anchorKey,
                            reason: 'Похоже на «' + titleOf(signal.card) + '»'
                        });
                        done();
                    } else {
                        tmdbGet(type + '/' + signal.card.id + '/similar', {}, function (similar) {
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
            var genres = topGenres(profile, type, 2);
            if (genres.length) {
                tasks.push(function (done) {
                    tmdbGet('discover/' + type, {
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
                tmdbGet('trending/' + type + '/week', {}, function (items) {
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

        return tasks;
    }

    function finalizeCandidates(profile, pool) {
        var mode = setting('mode', 'balanced');
        var hideSeen = boolSetting('hide_seen', true);
        var entries = Object.keys(pool.items).map(function (key) {
            var entry = pool.items[key];
            entry.score = scoreCandidate(entry, profile, mode, pool.maximumSource);
            return entry;
        }).filter(function (entry) {
            if (!entry.card.poster_path && !entry.card.backdrop_path) return false;
            if (hideSeen && profile.seen[entry.key]) return false;
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

        var selected = selectDiverse(entries, 24, mode);
        var lines = [];
        if (selected.length) {
            lines.push({
                title: profile.coldStart ? 'Популярно сейчас — отметьте любимое' : 'Для вас',
                results: cards(selected),
                nomore: true
            });
        }

        profile.positive.slice(0, 2).forEach(function (signal) {
            var keys = pool.anchors[signal.key] || [];
            var anchorEntries = keys.map(function (key) { return pool.items[key]; }).filter(function (entry) {
                return entry && (!hideSeen || !profile.seen[entry.key]);
            }).sort(function (left, right) { return right.score - left.score; });
            anchorEntries = selectDiverse(anchorEntries, 16, mode);
            if (anchorEntries.length >= 4) {
                lines.push({
                    title: 'Потому что вам нравится «' + titleOf(signal.card) + '»',
                    results: cards(anchorEntries),
                    nomore: true
                });
            }
        });

        var exploration = entries.filter(function (entry) {
            return entry.exploration && affinityScore(entry.card, profile) < 0.45;
        });
        exploration = selectDiverse(exploration, 18, 'explore');
        if (!profile.coldStart && exploration.length >= 5) {
            lines.push({
                title: 'Попробовать новое',
                results: cards(exploration),
                nomore: true
            });
        }

        var movies = selected.filter(function (entry) { return mediaType(entry.card) === 'movie'; });
        var shows = selected.filter(function (entry) { return mediaType(entry.card) === 'tv'; });
        if (movies.length >= 5 && shows.length >= 5) {
            lines.push({ title: 'Фильмы для вас', results: cards(movies), nomore: true });
            lines.push({ title: 'Сериалы для вас', results: cards(shows), nomore: true });
        }

        return {
            lines: lines,
            meta: {
                generatedAt: Date.now(),
                signals: profile.signals.length,
                candidates: entries.length,
                coldStart: profile.coldStart
            }
        };
    }

    function generateRecommendations(profile, callback) {
        var pool = new CandidatePool(profile);
        nativeRecommendations(pool);
        runQueue(recommendationTasks(profile, pool), 3, function () {
            callback(finalizeCandidates(profile, pool));
        });
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

    function refresh() {
        clearCache();
        getRecommendations(true, function (payload) {
            notify(payload.lines.length ? 'Рекомендации обновлены' : 'Не удалось получить рекомендации', !payload.lines.length);
        });
    }

    function RecommendationsComponent(object) {
        var component = new Lampa.InteractionMain(object);
        var alive = true;
        var originalDestroy = component.destroy;

        component.create = function () {
            var self = this;
            self.activity.loader(true);
            getRecommendations(object.force === true, function (payload) {
                if (!alive) return;
                if (!payload.lines.length) self.empty();
                else self.build(jsonClone(payload.lines));
            });
            return this.render();
        };

        component.destroy = function () {
            alive = false;
            originalDestroy.call(this);
        };

        return component;
    }

    function openRecommendations(force) {
        Lampa.Activity.push({
            url: '',
            title: 'Умные рекомендации',
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
                '<div class="menu__text">Для вас</div></li>');
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
            name: 'Умные рекомендации',
            icon: menuIcon()
        });

        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'enabled', type: 'trigger', default: true },
            field: { name: 'Включить плагин', description: 'Показывать раздел «Для вас» в боковом меню.' },
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
            field: { name: 'Скрывать просмотренное' },
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
            param: { name: PREFIX + 'clear_feedback', type: 'button' },
            field: { name: 'Очистить «больше/меньше похожего»', description: 'История и обычные закладки Lampa не удаляются.' },
            onChange: clearFeedback
        });
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: PREFIX + 'privacy', type: 'static' },
            field: {
                name: 'Приватность · версия ' + VERSION,
                description: 'Профиль и полная история никуда не загружаются. ID опорных фильмов запрашиваются через встроенный TMDB-клиент Lampa.'
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

    function registerFeedbackMenus() {
        Lampa.Manifest.plugins = {
            type: 'video',
            onContextMenu: function () { return { title: 'Больше похожего' }; },
            onContextLauch: function (card) { setFeedback(card, 1); }
        };
        Lampa.Manifest.plugins = {
            type: 'video',
            onContextMenu: function () { return { title: 'Меньше похожего' }; },
            onContextLauch: function (card) { setFeedback(card, -1); }
        };
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

    function invalidateOnTasteChange() {
        function invalidate() { clearCache(); }
        if (Lampa.Favorite && Lampa.Favorite.listener) {
            Lampa.Favorite.listener.follow('add,remove,added', invalidate);
        }
        if (Lampa.Timeline && Lampa.Timeline.listener) {
            Lampa.Timeline.listener.follow('update', invalidate);
        }
        Lampa.Listener.follow('state:changed', function (event) {
            if (event && (event.target === 'favorite' || event.target === 'timeline')) invalidate();
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
        Lampa.Component.add(COMPONENT, RecommendationsComponent);
        registerSettings();
        registerFeedbackMenus();
        registerHomeRow();
        invalidateOnTasteChange();
        updateMenu();

        setTimeout(function () {
            if (boolSetting('enabled', true)) getRecommendations(false, function () {});
        }, 2500);

        console.log('[SmartRecs] Ready v' + VERSION + '; local profile, no user API keys');
    }

    window.LampaSmartRecs = {
        version: VERSION,
        open: openRecommendations,
        refresh: refresh,
        clearFeedback: clearFeedback,
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
