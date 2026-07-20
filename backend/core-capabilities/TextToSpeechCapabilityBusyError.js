class TextToSpeechCapabilityBusyError extends Error {
    constructor() {
        super("TTS is busy");
        this.name = "TextToSpeechCapabilityBusyError";
    }
}

module.exports = TextToSpeechCapabilityBusyError;
