const Logger = require("../../../backend/lib/Logger");
const TextToSpeechCapability = require("../core-capabilities/TextToSpeechCapability");
const {exec, execSync} = require("child_process");
const fs = require("fs");
const https = require("https");
const path = require("path");

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
     */
    constructor(options) {
        super(options);

        const defaults = {
            tempDir: "/tmp",
            playerCommand: "aplay",
            defaultLanguage: "en",
            maxTextLength: 200,
        };

        this.ttsConfig = Object.assign({}, defaults, options.ttsConfig || {});

        this._speaking = false;
        this._currentText = null;
        this._playerProcess = null;
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

        const lang = language || this.ttsConfig.defaultLanguage;
        const audioFile = path.join(this.ttsConfig.tempDir, "valetudo_tts.mp3");

        Logger.info(`TTS: Speaking "${text}" in language "${lang}"`);

        try {
            this._speaking = true;
            this._currentText = text;

            // Step 1: Download TTS audio from Google Translate
            await this._downloadTTSAudio(text, lang, audioFile);

            // Step 2: Convert to WAV format for aplay compatibility
            const wavFile = path.join(this.ttsConfig.tempDir, "valetudo_tts.wav");
            await this._convertToWav(audioFile, wavFile);

            // Step 3: Play the audio
            await this._playAudio(wavFile);

        } catch (e) {
            Logger.error("TTS: Failed to speak", e);
            throw e;
        } finally {
            this._speaking = false;
            this._currentText = null;
            // Clean up temp audio files
            try { fs.unlinkSync(audioFile); } catch (_) {}
            try { fs.unlinkSync(path.join(this.ttsConfig.tempDir, "valetudo_tts.wav")); } catch (_) {}
        }
    }

    /**
     * @param {string} filePath
     * @returns {Promise<void>}
     */
    async playAudioFile(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Audio file not found: ${filePath}`);
        }

        Logger.info(`TTS: Playing audio file ${filePath}`);

        try {
            this._speaking = true;
            await this._playAudio(filePath);
        } finally {
            this._speaking = false;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async stopAudio() {
        Logger.info("TTS: Stopping audio playback");

        try {
            execSync(`killall ${this.ttsConfig.playerCommand} 2>/dev/null`);
            execSync("killall ffmpeg 2>/dev/null");
        } catch (e) {
            // Process might not exist
        }

        this._speaking = false;
        this._currentText = null;
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
     * @returns {Promise<void>}
     */
    _downloadTTSAudio(text, language, outputPath) {
        return new Promise((resolve, reject) => {
            const encodedText = encodeURIComponent(text);
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${language}&q=${encodedText}`;

            const file = fs.createWriteStream(outputPath);

            https.get(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0",
                },
            }, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    response.resume(); // Discard redirect body so socket doesn't hang
                    const location = response.headers.location;
                    if (!location) {
                        file.close();
                        fs.unlink(outputPath, () => {});
                        reject(new Error("TTS redirect had no Location header"));
                        return;
                    }
                    https.get(location, {
                        headers: {"User-Agent": "Mozilla/5.0"},
                    }, (redirectResponse) => {
                        if (redirectResponse.statusCode !== 200) {
                            redirectResponse.resume();
                            file.close();
                            fs.unlink(outputPath, () => {});
                            reject(new Error(`TTS redirect failed with status ${redirectResponse.statusCode}`));
                            return;
                        }
                        redirectResponse.pipe(file);
                        file.on("finish", () => {
                            file.close(() => resolve());
                        });
                    }).on("error", (e) => {
                        file.close();
                        fs.unlink(outputPath, () => {});
                        reject(e);
                    });
                } else if (response.statusCode === 200) {
                    response.pipe(file);
                    file.on("finish", () => {
                        file.close(resolve);
                    });
                } else {
                    response.resume();
                    file.close();
                    fs.unlink(outputPath, () => {});
                    reject(new Error(`TTS download failed with status ${response.statusCode}`));
                }
            }).on("error", (e) => {
                file.close();
                fs.unlink(outputPath, () => {}); // Clean up partial file
                reject(e);
            });
        });
    }

    /**
     * Convert MP3 to WAV using ffmpeg (if available) or play MP3 directly
     * @private
     * @param {string} mp3Path
     * @param {string} wavPath
     * @returns {Promise<void>}
     */
    _convertToWav(mp3Path, wavPath) {
        return new Promise((resolve, reject) => {
            // Try ffmpeg first, fall back to mpg123 or direct playback
            exec(`which ffmpeg`, (err) => {
                if (!err) {
                    exec(`ffmpeg -y -i "${mp3Path}" -ar 16000 -ac 1 -f wav "${wavPath}"`, (error) => {
                        if (error) {
                            Logger.warn("TTS: ffmpeg conversion failed, will try playing MP3 directly");
                            // Copy mp3 as fallback
                            fs.copyFileSync(mp3Path, wavPath);
                        }
                        resolve();
                    });
                } else {
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
     * @returns {Promise<void>}
     */
    _playAudio(audioPath) {
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

            exec(command, (error) => {
                if (error && error.code !== 0) {
                    Logger.warn(`TTS: Audio playback command returned code ${error.code}`);
                }
                // Resolve even on error — the audio may have played partially
                resolve();
            });
        });
    }
}

module.exports = DreameTextToSpeechCapability;
