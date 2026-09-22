const MicrophoneGainCapability = require("../core-capabilities/MicrophoneGainCapability");
const {runNativeScriptJson, sanitizedScriptEnv} = require("./runNativeScript");

/**
 * Dreame-specific microphone gain capability.
 *
 * Delegates to mic_gain_ctl.sh, which reads and writes the ALSA mic gain
 * controls (amixer numid 5 and 6) directly.
 *
 * @extends MicrophoneGainCapability<import("../../../backend/lib/robots/dreame/DreameValetudoRobot")>
 */
class DreameMicrophoneGainCapability extends MicrophoneGainCapability {
    /**
     * @param {object} options
     * @param {import("../../../backend/lib/robots/dreame/DreameValetudoRobot")} options.robot
     * @param {object} [options.scriptConfig]
     * @param {string} [options.scriptConfig.micGainCtlPath] - Native script that reads and sets microphone gain
     */
    constructor(options) {
        super(options);

        const defaults = {
            micGainCtlPath: "/data/vacuumstreamer/mic_gain_ctl.sh",
        };

        this.scriptConfig = Object.assign({}, defaults, options.scriptConfig || {});
    }

    /**
     * @returns {Promise<number>}
     */
    async getGain() {
        const result = await this._runMicGainCtl(["get"]);

        return result.mic_volume;
    }

    /**
     * @param {number} value
     * @returns {Promise<void>}
     */
    async setGain(value) {
        const {min, max} = this.getProperties();

        if (!Number.isInteger(value) || value < min || value > max) {
            throw new Error(`Microphone gain must be an integer between ${min} and ${max}`);
        }

        await this._runMicGainCtl(["set", String(value)]);
    }

    /**
     * @private
     * @param {string[]} args
     * @returns {Promise<{mic_volume: number, raw: number}>}
     */
    _runMicGainCtl(args) {
        return runNativeScriptJson("mic_gain_ctl", this.scriptConfig.micGainCtlPath, args, {
            timeout: 10000,
            env: sanitizedScriptEnv(),
        });
    }
}

module.exports = DreameMicrophoneGainCapability;
