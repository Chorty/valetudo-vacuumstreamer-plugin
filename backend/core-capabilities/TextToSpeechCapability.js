const Capability = require("../../../backend/lib/core/capabilities/Capability");
const NotImplementedError = require("../../../backend/lib/core/NotImplementedError");
const {EventEmitter} = require("events");

const SPEAKING_CHANGED_EVENT = "speakingChanged";

/**
 * Capability for text-to-speech and audio playback on the vacuum.
 * Uses Google Translate TTS API to generate speech and plays it
 * through the vacuum's speaker.
 *
 * Playback typically lasts a few seconds, far shorter than the MQTT
 * controller's periodic 30-second property refresh. Subclasses call
 * {@link TextToSpeechCapability#_setSpeaking} instead of tracking their own
 * speaking flag directly, so that {@link TextToSpeechCapability#onSpeakingChanged}
 * listeners -- used by TextToSpeechCapabilityMqttHandle to publish the
 * "speaking" property immediately -- fire on every transition, not just
 * whichever ones happen to land on a poll.
 *
 * @template {import("../../../backend/lib/core/ValetudoRobot")} T
 * @extends Capability<T>
 */
class TextToSpeechCapability extends Capability {
    /**
     * @param {object} options
     * @param {T} options.robot
     */
    constructor(options) {
        super(options);

        this._speaking = false;
        this._speakingEvents = new EventEmitter();
    }

    /**
     * Register a listener invoked with the new value whenever speaking starts or stops.
     *
     * @param {(speaking: boolean) => void} listener
     */
    onSpeakingChanged(listener) {
        this._speakingEvents.on(SPEAKING_CHANGED_EVENT, listener);
    }

    /**
     * @protected
     * @param {boolean} speaking
     */
    _setSpeaking(speaking) {
        if (this._speaking === speaking) {
            return;
        }

        this._speaking = speaking;
        this._speakingEvents.emit(SPEAKING_CHANGED_EVENT, speaking);
    }

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
