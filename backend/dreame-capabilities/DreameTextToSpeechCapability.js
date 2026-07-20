const fs = require("fs");
const https = require("https");
const Logger = require("../../../backend/lib/Logger");
const path = require("path");
const TextToSpeechCapability = require("../core-capabilities/TextToSpeechCapability");
const TextToSpeechCapabilityBusyError = require("../core-capabilities/TextToSpeechCapabilityBusyError");
const {exec, execSync} = require("child_process");

/**
 * Dreame-specific TTS capability.
 *
 * Uses Google Translate's TTS endpoint to generate speech audio, downloads it
 * to the vacuum, and plays it through the speaker using the `aplay` command
 * (or the vacuum's built-in audio player).
 *
 * @extends TextToSpeechCapability<import("../../../backend/lib/robots/dreame/DreameValetudoRobot")>
 */
class DreameTextToSpeechCapability extends TextToSpeechCapability {
    /**
     * @param {object} options
     * @param {import("../../../backend/lib/robots/dreame/DreameValetudoRobot")} options.robot
     * @param {object} [options.ttsConfig]
     * @param {string} [options.ttsConfig.tempDir] - Directory for temp audio files
     * @param {string} [options.ttsConfig.playerCommand] - Audio player command
     * @param {string} [options.ttsConfig.defaultLanguage] - Default TTS language
     * @param {number} [options.ttsConfig.maxTextLength] - Maximum text length for TTS
     * @param {number} [options.ttsConfig.downloadTimeoutMs] - TTS download timeout in milliseconds
     */
    constructor(options) {
        super(options);

        const defaults = {
            tempDir: "/tmp",
            playerCommand: "aplay",
            defaultLanguage: "en",
            maxTextLength: 200,
            downloadTimeoutMs: 10000,
        };

        this.ttsConfig = Object.assign({}, defaults, options.ttsConfig || {});
        if (!Number.isInteger(this.ttsConfig.downloadTimeoutMs) ||
            this.ttsConfig.downloadTimeoutMs < MIN_DOWNLOAD_TIMEOUT_MS ||
            this.ttsConfig.downloadTimeoutMs > MAX_DOWNLOAD_TIMEOUT_MS) {
            throw new Error(`downloadTimeoutMs must be an integer between ${MIN_DOWNLOAD_TIMEOUT_MS} and ${MAX_DOWNLOAD_TIMEOUT_MS}`);
        }

        this._speaking = false;
        this._currentText = null;
        this._playerProcess = null;
        this._conversionProcess = null;
        this._activeAudioJob = null;
        this._activeAbortController = null;
    }

    /**
     * @param {string} text
     * @param {string} [language]
     * @returns {Promise<void>}
     */
    async speak(text, language) {
        if (!text || text.trim().length === 0) {
            throw new Error("Text cannot be empty");
        }

        if (text.length > this.ttsConfig.maxTextLength) {
            throw new Error(`Text too long. Maximum ${this.ttsConfig.maxTextLength} characters.`);
        }

        return this._runExclusiveAudioJob(async signal => {
            const lang = language || this.ttsConfig.defaultLanguage;
            const workDir = fs.mkdtempSync(path.join(this.ttsConfig.tempDir, "valetudo-tts-"));
            const audioFile = path.join(workDir, "speech.mp3");
            const wavFile = path.join(workDir, "speech.wav");

            Logger.info(`TTS: Speaking "${text}" in language "${lang}"`);

            try {
                this._speaking = true;
                this._currentText = text;

                await this._downloadTTSAudio(text, lang, audioFile, signal);
                throwIfAborted(signal);
                await this._convertToWav(audioFile, wavFile, signal);
                throwIfAborted(signal);
                await this._playAudio(wavFile, signal);
            } catch (e) {
                Logger.error("TTS: Failed to speak", e);
                throw e;
            } finally {
                this._speaking = false;
                this._currentText = null;
                fs.rmSync(workDir, {recursive: true, force: true});
            }
        });
    }

    /**
     * @param {string} filePath
     * @returns {Promise<void>}
     */
    async playAudioFile(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Audio file not found: ${filePath}`);
        }

        return this._runExclusiveAudioJob(async signal => {
            Logger.info(`TTS: Playing audio file ${filePath}`);

            try {
                this._speaking = true;
                await this._playAudio(filePath, signal);
            } finally {
                this._speaking = false;
            }
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async stopAudio() {
        Logger.info("TTS: Stopping audio playback");

        const activeJob = this._activeAudioJob;
        this._activeAbortController?.abort();
        try {
            this._conversionProcess?.kill();
        } catch (_) {
            // It may already have exited.
        }
        try {
            this._playerProcess?.kill();
        } catch (_) {
            // It may already have exited.
        }

        this._stopPlaybackProcesses();

        this._speaking = false;
        this._currentText = null;

        if (activeJob !== null) {
            await activeJob.catch(() => undefined);
        }
    }

    /**
     * @private
     */
    _stopPlaybackProcesses() {
        try {
            execSync(`killall ${this.ttsConfig.playerCommand} 2>/dev/null`);
            execSync("killall ffmpeg 2>/dev/null");
        } catch (e) {
            // Process might not exist
        }
    }

    /**
     * @returns {Promise<import("../core-capabilities/TextToSpeechCapability").TTSStatus>}
     */
    async getStatus() {
        return {
            speaking: this._speaking,
            currentText: this._currentText,
            language: this.ttsConfig.defaultLanguage,
        };
    }

    /**
     * @returns {object}
     */
    getProperties() {
        return {
            maxTextLength: this.ttsConfig.maxTextLength,
            defaultLanguage: this.ttsConfig.defaultLanguage,
            supportedLanguages: [
                "en", "de", "fr", "es", "it", "pt", "nl", "pl", "ru",
                "ja", "ko", "zh-CN", "zh-TW", "ar", "hi", "tr", "sv",
                "da", "no", "fi", "cs", "el", "he", "hu", "ro", "th",
                "uk", "vi", "id", "ms",
            ],
        };
    }

    /**
     * Download TTS audio from Google Translate
     * @private
     * @param {string} text
     * @param {string} language
     * @param {string} outputPath
     * @param {AbortSignal} signal
     * @returns {Promise<void>}
     */
    _downloadTTSAudio(text, language, outputPath, signal) {
        return new Promise((resolve, reject) => {
            const encodedText = encodeURIComponent(text);
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${language}&q=${encodedText}`;
            const file = fs.createWriteStream(outputPath);
            const requests = new Set();
            const responses = new Set();
            let settled = false;
            let timeout;

            const cleanup = () => {
                clearTimeout(timeout);
                signal.removeEventListener("abort", onAbort);
            };
            const fail = error => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                requests.forEach(request => request.destroy());
                responses.forEach(response => response.destroy());
                file.destroy();
                fs.unlink(outputPath, () => {});
                reject(error);
            };
            const succeed = () => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                file.close(error => error ? reject(error) : resolve());
            };
            const onAbort = () => fail(createCancellationError());
            timeout = setTimeout(() => {
                fail(new Error(`TTS download timed out after ${this.ttsConfig.downloadTimeoutMs}ms`));
            }, this.ttsConfig.downloadTimeoutMs);

            const download = (downloadUrl, allowRedirect) => {
                if (signal.aborted) {
                    onAbort();
                    return;
                }

                let request;
                try {
                    request = https.get(downloadUrl, {
                        headers: {"User-Agent": "Mozilla/5.0"},
                    }, response => {
                        responses.add(response);
                        response.on("error", fail);
                        if (allowRedirect && (response.statusCode === 301 || response.statusCode === 302)) {
                            response.resume();
                            const location = response.headers.location;
                            if (!location) {
                                fail(new Error("TTS redirect had no Location header"));
                                return;
                            }

                            let redirectUrl;
                            try {
                                redirectUrl = new URL(location, downloadUrl);
                            } catch (_) {
                                fail(new Error("TTS redirect had an invalid Location header"));
                                return;
                            }
                            if (redirectUrl.protocol !== "https:") {
                                fail(new Error("TTS redirect must use HTTPS"));
                                return;
                            }
                            download(redirectUrl.toString(), false);
                        } else if (response.statusCode === 200) {
                            response.pipe(file);
                        } else {
                            response.resume();
                            fail(new Error(`TTS download failed with status ${response.statusCode}`));
                        }
                    });
                } catch (e) {
                    fail(e);
                    return;
                }
                requests.add(request);
                request.on("error", fail);
            };

            file.on("error", fail);
            file.on("finish", succeed);
            signal.addEventListener("abort", onAbort, {once: true});
            download(url, true);
        });
    }

    /**
     * Convert MP3 to WAV using ffmpeg (if available) or play MP3 directly
     * @private
     * @param {string} mp3Path
     * @param {string} wavPath
     * @param {AbortSignal} signal
     * @returns {Promise<void>}
     */
    _convertToWav(mp3Path, wavPath, signal) {
        return new Promise((resolve, reject) => {
            // Try ffmpeg first, fall back to mpg123 or direct playback
            this._conversionProcess = exec("which ffmpeg", (err) => {
                if (signal.aborted) {
                    reject(createCancellationError());
                    return;
                }
                if (!err) {
                    this._conversionProcess = exec(`ffmpeg -y -i "${mp3Path}" -ar 16000 -ac 1 -f wav "${wavPath}"`, (error) => {
                        this._conversionProcess = null;
                        if (signal.aborted) {
                            reject(createCancellationError());
                            return;
                        }
                        if (error) {
                            Logger.warn("TTS: ffmpeg conversion failed, will try playing MP3 directly");
                            // Copy mp3 as fallback
                            fs.copyFileSync(mp3Path, wavPath);
                        }
                        resolve();
                    });
                } else {
                    this._conversionProcess = null;
                    // No ffmpeg, just use the mp3 directly
                    fs.copyFileSync(mp3Path, wavPath);
                    resolve();
                }
            });
        });
    }

    /**
     * Play an audio file
     * @private
     * @param {string} audioPath
     * @param {AbortSignal} signal
     * @returns {Promise<void>}
     */
    _playAudio(audioPath, signal) {
        return new Promise((resolve, reject) => {
            // Try different playback methods
            const ext = path.extname(audioPath).toLowerCase();

            let command;
            if (ext === ".mp3") {
                // Try mpg123 for MP3 files, fall back to ffplay
                command = `mpg123 -q "${audioPath}" 2>/dev/null || ffplay -nodisp -autoexit "${audioPath}" 2>/dev/null`;
            } else {
                // WAV files can use aplay
                command = `${this.ttsConfig.playerCommand} "${audioPath}" 2>/dev/null`;
            }

            this._playerProcess = exec(command, (error) => {
                this._playerProcess = null;
                if (signal.aborted) {
                    reject(createCancellationError());
                    return;
                }
                if (error && error.code !== 0) {
                    Logger.warn(`TTS: Audio playback command returned code ${error.code}`);
                }
                // Resolve even on error — the audio may have played partially
                resolve();
            });
        });
    }

    /**
     * @private
     * @template T
     * @param {(signal: AbortSignal) => Promise<T>} operation
     * @returns {Promise<T>}
     */
    async _runExclusiveAudioJob(operation) {
        if (this._activeAudioJob !== null) {
            throw new TextToSpeechCapabilityBusyError();
        }

        const abortController = new AbortController();
        const job = Promise.resolve().then(() => operation(abortController.signal));
        this._activeAbortController = abortController;
        this._activeAudioJob = job;

        try {
            return await job;
        } finally {
            if (this._activeAudioJob === job) {
                this._activeAudioJob = null;
                this._activeAbortController = null;
            }
        }
    }
}

/**
 * @param {AbortSignal} signal
 */
function throwIfAborted(signal) {
    if (signal.aborted) {
        throw createCancellationError();
    }
}

function createCancellationError() {
    const error = new Error("TTS operation cancelled");
    error.name = "AbortError";
    return error;
}

const MIN_DOWNLOAD_TIMEOUT_MS = 100;
const MAX_DOWNLOAD_TIMEOUT_MS = 120000;

module.exports = DreameTextToSpeechCapability;
