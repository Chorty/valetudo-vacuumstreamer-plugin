const Capability = require("../../../backend/lib/core/capabilities/Capability");
const NotImplementedError = require("../../../backend/lib/core/NotImplementedError");

/**
 * Capability for text-to-speech and audio playback on the vacuum.
 * Uses Google Translate TTS API to generate speech and plays it
 * through the vacuum's speaker.
 *
 * @template {import("../../../backend/lib/core/ValetudoRobot")} T
 * @extends Capability<T>
 */
class TextToSpeechCapability extends Capability {
    /**
     * Speak a text message through the vacuum's speaker
     *
     * @abstract
     * @param {string} text - The text to speak
     * @param {string} [language="en"] - Language code (e.g., "en", "de", "fr")
     * @returns {Promise<void>}
     */
    async speak(text, language) {
        throw new NotImplementedError();
    }

    /**
     * Play an audio file on the vacuum
     *
     * @abstract
     * @param {string} filePath - Path to audio file on the vacuum
     * @returns {Promise<void>}
     */
    async playAudioFile(filePath) {
        throw new NotImplementedError();
    }

    /**
     * Stop any currently playing audio
     *
     * @abstract
     * @returns {Promise<void>}
     */
    async stopAudio() {
        throw new NotImplementedError();
    }

    /**
     * Get current TTS status
     *
     * @abstract
     * @returns {Promise<TTSStatus>}
     */
    async getStatus() {
        throw new NotImplementedError();
    }

    getType() {
        return TextToSpeechCapability.TYPE;
    }
}

/**
 * @typedef {object} TTSStatus
 * @property {boolean} speaking - Whether audio is currently playing
 * @property {string} [currentText] - Text currently being spoken
 * @property {string} [language] - Current language setting
 */

TextToSpeechCapability.TYPE = "TextToSpeechCapability";

module.exports = TextToSpeechCapability;
