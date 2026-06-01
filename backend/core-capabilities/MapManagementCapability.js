const Capability = require("../../../backend/lib/core/capabilities/Capability");
const NotImplementedError = require("../../../backend/lib/core/NotImplementedError");

/**
 * Manage multiple maps: save, load, delete, export, and import map backups.
 *
 * Maps on Dreame robots consist of several directories (/data/ri, /data/map,
 * /data/DivideMap, /data/config/ava/mult_map.json).  This capability allows
 * users to save the current map under a name, switch between saved maps, and
 * export/import map archives for backup purposes.
 *
 * @template {import("../../../backend/lib/core/ValetudoRobot")} T
 * @extends Capability<T>
 */
class MapManagementCapability extends Capability {
    /**
     * List all saved map backups.
     *
     * @abstract
     * @returns {Promise<Array<{id: string, name: string, timestamp: number}>>}
     */
    async getMapList() {
        throw new NotImplementedError();
    }

    /**
     * Save (backup) the current active map under the given name.
     *
     * @abstract
     * @param {string} name - Human-readable name for the saved map
     * @returns {Promise<{id: string, name: string}>}
     */
    async saveMap(name) {
        throw new NotImplementedError();
    }

    /**
     * Load a previously saved map, replacing the current active map.
     * The current map is optionally auto-saved before loading.
     *
     * @abstract
     * @param {string} id - The map id to load
     * @returns {Promise<void>}
     */
    async loadMap(id) {
        throw new NotImplementedError();
    }

    /**
     * Delete a saved map backup.
     *
     * @abstract
     * @param {string} id - The map id to delete
     * @returns {Promise<void>}
     */
    async deleteMap(id) {
        throw new NotImplementedError();
    }

    /**
     * Rename a saved map backup.
     *
     * @abstract
     * @param {string} id - The map id to rename
     * @param {string} newName - The new name
     * @returns {Promise<void>}
     */
    async renameMap(id, newName) {
        throw new NotImplementedError();
    }

    /**
     * Export a saved map as a downloadable tar.gz archive.
     *
     * @abstract
     * @param {string} id - The map id to export
     * @returns {Promise<{filePath: string, fileName: string}>}
     */
    async exportMap(id) {
        throw new NotImplementedError();
    }

    /**
     * Import a map from an uploaded tar.gz archive buffer.
     *
     * @abstract
     * @param {Buffer} data - The tar.gz file contents
     * @param {string} name - Name to assign to the imported map
     * @returns {Promise<{id: string, name: string}>}
     */
    async importMap(data, name) {
        throw new NotImplementedError();
    }

    getType() {
        return MapManagementCapability.TYPE;
    }
}

MapManagementCapability.TYPE = "MapManagementCapability";

module.exports = MapManagementCapability;
