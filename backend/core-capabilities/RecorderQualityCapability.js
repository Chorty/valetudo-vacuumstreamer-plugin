const Capability = require("../../../backend/lib/core/capabilities/Capability");
const NotImplementedError = require("../../../backend/lib/core/NotImplementedError");

/**
 * Capability for controlling the vacuum's video recorder (encoder) quality
 * profile. Changing the profile may briefly restart video capture.
 *
 * @template {import("../../../backend/lib/core/ValetudoRobot")} T
 * @extends Capability<T>
 */
class RecorderQualityCapability extends Capability {
    /**
     * Get the current recorder quality.
     *
     * @abstract
     * @returns {Promise<RecorderQualityStatus>}
     */
    async getQuality() {
        throw new NotImplementedError();
    }

    /**
     * Set the recorder quality profile.
     *
     * @abstract
     * @param {string} profile - One of {@link RecorderQualityCapability#getProperties}.supportedProfiles
     * @returns {Promise<RecorderQualityStatus>}
     */
    async setQuality(profile) {
        throw new NotImplementedError();
    }

    getProperties() {
        return {
            supportedProfiles: ["low", "high"],
        };
    }

    getType() {
        return RecorderQualityCapability.TYPE;
    }
}

/**
 * @typedef {object} RecorderQualityStatus
 * @property {string} profile
 * @property {number} width
 * @property {number} height
 * @property {number} framerate
 * @property {number} bitrate
 */

RecorderQualityCapability.TYPE = "RecorderQualityCapability";

module.exports = RecorderQualityCapability;
