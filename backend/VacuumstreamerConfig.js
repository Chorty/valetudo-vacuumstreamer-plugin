const fs = require("fs");

const DEFAULT_CONFIG_PATH = "/data/vacuumstreamer/vacuumstreamer.conf";

/**
 * Switches shared with the native VacuumStreamer scripts, which read the same
 * file through vacuumstreamer_lib.sh. The defaults reproduce the behavior from
 * before the switches existed.
 */
const SWITCH_DEFAULTS = Object.freeze({
    CAMERA: "on",
    CAMERA_LOGIN: "off",
    TTS: "on",
    MAP_MANAGEMENT: "on",
    HTTP_BRIDGE: "on",
});

/**
 * Parses KEY=value lines the same way as vs_conf_get in vacuumstreamer_lib.sh:
 * leading whitespace is ignored, "#" starts a comment, the value is trimmed, and
 * the last occurrence of a key wins even when its value is empty.
 *
 * @param {string} text
 * @returns {Object<string, string>}
 */
function parseConfigText(text) {
    /** @type {Object<string, string>} */
    const values = {};

    for (const line of text.split("\n")) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*([^#]*)/.exec(line);

        if (match) {
            values[match[1]] = match[2].trim();
        }
    }

    return values;
}

/**
 * @typedef {object} VacuumstreamerConfig
 * @property {string} path
 * @property {boolean} found - Whether the config file was read
 * @property {Object<string, boolean>} switches - true when switched on
 * @property {Array<string>} warnings
 */

/**
 * Loads the switches. A missing or unreadable file, an empty value, or an
 * invalid value falls back to the default for that switch.
 *
 * @param {object} [options]
 * @param {string} [options.path]
 * @param {(path: string) => string} [options.readFile]
 * @returns {VacuumstreamerConfig}
 */
function loadVacuumstreamerConfig(options = {}) {
    const path = options.path ?? DEFAULT_CONFIG_PATH;
    const readFile = options.readFile ?? (filePath => fs.readFileSync(filePath, "utf-8"));
    /** @type {Array<string>} */
    const warnings = [];
    /** @type {Object<string, string>} */
    let values = {};
    let found = false;

    try {
        values = parseConfigText(readFile(path));
        found = true;
    } catch (e) {
        if (e.code !== "ENOENT") {
            warnings.push(`could not read ${path} (${e.code ?? e.message}); using defaults`);
        }
    }

    /** @type {Object<string, boolean>} */
    const switches = {};

    for (const [name, defaultValue] of Object.entries(SWITCH_DEFAULTS)) {
        const value = values[name];

        if (value === "on" || value === "off") {
            switches[name] = value === "on";
        } else {
            if (value !== undefined && value !== "") {
                warnings.push(`invalid value for ${name} in ${path}; using ${defaultValue}`);
            }

            switches[name] = defaultValue === "on";
        }
    }

    return {
        path: path,
        found: found,
        switches: switches,
        warnings: warnings,
    };
}

module.exports = {
    DEFAULT_CONFIG_PATH: DEFAULT_CONFIG_PATH,
    SWITCH_DEFAULTS: SWITCH_DEFAULTS,
    loadVacuumstreamerConfig: loadVacuumstreamerConfig,
    parseConfigText: parseConfigText,
};
