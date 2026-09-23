const Capability = require("../../../backend/lib/core/capabilities/Capability");
const NotImplementedError = require("../../../backend/lib/core/NotImplementedError");

/**
 * Capability for controlling the vacuum's microphone gain, used for
 * two-way audio over the video stream.
 *
 * @template {import("../../../backend/lib/core/ValetudoRobot")} T
 * @extends Capability<T>
 */
class MicrophoneGainCapability extends Capability {
    /**
     * Get the current microphone gain.
     *
     * @abstract
     * @returns {Promise<number>} 0-100
     */
    async getGain() {
        throw new NotImplementedError();
    }

    /**
     * Set the microphone gain.
     *
     * @abstract
     * @param {number} value - 0-100
     * @returns {Promise<void>}
     */
    async setGain(value) {
        throw new NotImplementedError();
    }

    getProperties() {
        return {
            min: 0,
            max: 100,
        };
    }

    getType() {
        return MicrophoneGainCapability.TYPE;
    }
}

MicrophoneGainCapability.TYPE = "MicrophoneGainCapability";

module.exports = MicrophoneGainCapability;
