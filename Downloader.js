const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class Downloader {
    constructor(options = {}) {
        this.songsDir = options.songsDir || path.join(process.cwd(), 'songs');
        this.ytDlpPath = options.ytDlpPath || 'yt-dlp';
        this.ffmpegLocation = options.ffmpegLocation || '';
        this.jsRuntimes = options.jsRuntimes !== undefined && options.jsRuntimes !== null ? options.jsRuntimes : '';
        this.extractorArgs = options.extractorArgs || 'youtube:player_client=android,web_creator,web';
        this.maxDurationSeconds = Number(options.maxDurationSeconds || 600);
        this.cookiesFromBrowser = options.cookiesFromBrowser || '';
        this.searchCandidates = Number(options.searchCandidates || 10);
        this.cacheByVideoId = new Map();
        this.cacheByQuery = new Map();
        this.inflight = new Map();

        fs.mkdirSync(this.songsDir, { recursive: true });
    }

    async searchAndDownload(query, metadata = {}) {
        const normalized = this._normalizeQuery(query);
        if (this.cacheByQuery.has(normalized)) {
            const cachedByQuery = this.cacheByQuery.get(normalized);
            if (cachedByQuery && fs.existsSync(cachedByQuery.filePath)) {
                return cachedByQuery;
            }

            this._evictSongFromCaches(cachedByQuery);
        }

        const inflightKey = `query:${normalized}`;
        if (this.inflight.has(inflightKey)) {
            return this.inflight.get(inflightKey);
        }

        const downloadTask = (async () => {
            const info = await this._searchYoutube(query);
            if (!info || !info.id) {
                throw new Error('No YouTube result found.');
            }

            if (this._isTooLong(info.duration)) {
                throw new Error('Requested track is longer than 10 minutes.');
            }

            if (this.cacheByVideoId.has(info.id)) {
                const cached = this.cacheByVideoId.get(info.id);
                if (cached && fs.existsSync(cached.filePath)) {
                    this.cacheByQuery.set(normalized, cached);
                    return cached;
                }

                this._evictSongFromCaches(cached);
            }

            const songPath = path.join(this.songsDir, `${info.id}.mp3`);
            if (fs.existsSync(songPath)) {
                const local = this._buildSongRecord(info, songPath, query, metadata);
                this._remember(local, normalized);
                return local;
            }

            await this._downloadAudio(info.id, songPath);
            const song = this._buildSongRecord(info, songPath, query, metadata);
            this._remember(song, normalized);
            return song;
        })();

        this.inflight.set(inflightKey, downloadTask);

        try {
            return await downloadTask;
        } finally {
            this.inflight.delete(inflightKey);
        }
    }

    hasVideo(videoId) {
        return this.cacheByVideoId.has(videoId);
    }

    getByVideoId(videoId) {
        return this.cacheByVideoId.get(videoId) || null;
    }

    async pruneOldSongs(maxFiles = 150) {
        const files = fs
            .readdirSync(this.songsDir)
            .filter((name) => name.toLowerCase().endsWith('.mp3'))
            .map((name) => {
                const fullPath = path.join(this.songsDir, name);
                return { name, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        if (files.length <= maxFiles) {
            return;
        }

        const removable = files.slice(maxFiles);
        for (const file of removable) {
            try {
                fs.unlinkSync(file.fullPath);
            } catch (_) {
                // Ignore per-file prune failures.
            }
        }
    }

    async clearAllSongs() {
        try {
            const files = fs
                .readdirSync(this.songsDir)
                .filter((name) => name.toLowerCase().endsWith('.mp3'))
                .map((name) => path.join(this.songsDir, name));

            for (const filePath of files) {
                try {
                    fs.unlinkSync(filePath);
                } catch (_) {
                    // Ignore per-file deletion failures.
                }
            }

            // Clear caches
            this.cacheByVideoId.clear();
            this.cacheByQuery.clear();

            console.log(`Cleared ${files.length} songs from ${this.songsDir}`);
        } catch (error) {
            console.error('Failed to clear songs directory:', error.message);
        }
    }

    _remember(song, normalizedQuery) {
        this.cacheByVideoId.set(song.videoId, song);
        if (normalizedQuery) {
            this.cacheByQuery.set(normalizedQuery, song);
        }
    }

    _buildSongRecord(info, filePath, query, metadata) {
        return {
            id: `${info.id}:${Date.now()}`,
            videoId: info.id,
            title: info.title || query,
            singer: info.artist || info.track_artist || info.album_artist || info.channel || info.uploader || info.creator || metadata.singer || 'AutoDJ',
            query,
            url: info.webpage_url || `https://www.youtube.com/watch?v=${info.id}`,
            requestedBy: metadata.requestedBy || 'AutoDJ',
            requestedById: metadata.requestedById || null,
            source: metadata.source || 'user',
            filePath,
            duration: info.duration || null,
            createdAt: Date.now()
        };
    }

    _normalizeQuery(query) {
        return String(query || '').trim().toLowerCase();
    }

    async _searchYoutube(query) {
        const candidateCount = Number.isFinite(this.searchCandidates) && this.searchCandidates > 0
            ? Math.floor(this.searchCandidates)
            : 10;

        const args = [
            '--dump-single-json',
            '--skip-download',
            '--no-playlist',
            `ytsearch${candidateCount}:${query}`
        ];

        this._injectYtDlpRuntimeArgs(args);
        this._injectYtDlpExtractorArgs(args);
        this._injectYtDlpCookiesArgs(args);

        const output = await this._runYtDlp(args);
        const parsed = JSON.parse(output);

        if (parsed && Array.isArray(parsed.entries) && parsed.entries.length > 0) {
            const shortEntry = parsed.entries.find((entry) => !this._isTooLong(entry?.duration));
            if (shortEntry) {
                return shortEntry;
            }

            return parsed.entries[0];
        }

        return parsed;
    }

    async _downloadAudio(videoId, outputFile) {
        const outputTemplate = outputFile.replace(/\.mp3$/i, '.%(ext)s');
        const args = [
            '--no-playlist',
            '--extract-audio',
            '--audio-format',
            'mp3',
            '--audio-quality',
            '0',
            '--match-filter',
            `duration <= ${this.maxDurationSeconds}`,
            '-o',
            outputTemplate,
            `https://www.youtube.com/watch?v=${videoId}`
        ];

        this._injectYtDlpRuntimeArgs(args);
        this._injectYtDlpExtractorArgs(args);
        this._injectYtDlpCookiesArgs(args);
        this._injectYtDlpFfmpegArgs(args);

        await this._runYtDlp(args);

        if (!fs.existsSync(outputFile)) {
            throw new Error('yt-dlp finished but MP3 file was not created.');
        }
    }

    _runYtDlp(args) {
        return new Promise((resolve, reject) => {
            const child = spawn(this.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });

            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            child.on('error', (error) => {
                reject(new Error(`Failed to run yt-dlp: ${error.message}`));
            });

            child.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim()}`));
                    return;
                }

                resolve(stdout.trim());
            });
        });
    }

    _injectYtDlpRuntimeArgs(args) {
        const runtimes = String(this.jsRuntimes || '').trim();
        if (!runtimes) {
            return;
        }

        args.unshift(runtimes);
        args.unshift('--js-runtimes');
    }

    _injectYtDlpExtractorArgs(args) {
        const extractorArgs = String(this.extractorArgs || '').trim();
        if (!extractorArgs) {
            return;
        }

        args.unshift(extractorArgs);
        args.unshift('--extractor-args');
    }

    _injectYtDlpCookiesArgs(args) {
        const cookiesFromBrowser = String(this.cookiesFromBrowser || '').trim();
        if (!cookiesFromBrowser) {
            return;
        }

        args.unshift(cookiesFromBrowser);
        args.unshift('--cookies-from-browser');
    }

    _injectYtDlpFfmpegArgs(args) {
        const rawLocation = String(this.ffmpegLocation || '').trim();
        if (!rawLocation) {
            return;
        }

        const ffmpegLocation = rawLocation.toLowerCase().endsWith('.exe')
            ? path.dirname(rawLocation)
            : rawLocation;

        args.unshift(ffmpegLocation);
        args.unshift('--ffmpeg-location');
    }

    _isTooLong(durationSeconds) {
        const duration = Number(durationSeconds);
        if (!Number.isFinite(duration) || duration <= 0) {
            return false;
        }

        return duration > this.maxDurationSeconds;
    }

    evictSong(song) {
        this._evictSongFromCaches(song);
    }

    _evictSongFromCaches(song) {
        if (!song) {
            return;
        }

        if (song.videoId) {
            this.cacheByVideoId.delete(song.videoId);
        }

        const entries = Array.from(this.cacheByQuery.entries());
        for (const [query, cachedSong] of entries) {
            if (!cachedSong) {
                this.cacheByQuery.delete(query);
                continue;
            }

            if (
                (song.videoId && cachedSong.videoId === song.videoId) ||
                (song.filePath && cachedSong.filePath === song.filePath)
            ) {
                this.cacheByQuery.delete(query);
            }
        }
    }
}

module.exports = Downloader;
