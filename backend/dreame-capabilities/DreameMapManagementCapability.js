const fs = require("fs");
const Logger = require("../../../backend/lib/Logger");
const MapManagementCapability = require("../core-capabilities/MapManagementCapability");
const path = require("path");
const {exec, execSync} = require("child_process");

/**
 * Dreame-specific map management capability.
 *
 * Manages multiple map backups on Dreame robots by copying the map data
 * directories to/from a storage location.  Compatible with the file layout
 * used by pkoehlers/maploader.
 *
 * Map data directories:
 *   /data/ri            — Robot intelligence / navigation data
 *   /data/map           — Map tiles and metadata
 *   /data/DivideMap     — Room division / segmentation data
 *   /data/config/ava/mult_map.json — Multi-map configuration
 *
 * Saved maps are stored under /data/maploader/<id>/
 * A metadata file at /data/maploader/<id>/metadata.json holds the map name
 * and timestamp.
 *
 * @extends MapManagementCapability<import("../../../backend/lib/robots/dreame/DreameValetudoRobot")>
 */
class DreameMapManagementCapability extends MapManagementCapability {
    /**
     * @param {object} options
     * @param {import("../../../backend/lib/robots/dreame/DreameValetudoRobot")} options.robot
     * @param {object} [options.mapConfig]
     * @param {string} [options.mapConfig.storagePath] - Where to store map backups
     * @param {Array<string>} [options.mapConfig.mapDirs] - Active map directories to save/restore
     * @param {string} [options.mapConfig.multMapConfig] - Path to mult_map.json
     */
    constructor(options) {
        super(options);

        const defaults = {
            storagePath: "/data/maploader",
            mapDirs: ["/data/ri", "/data/map", "/data/DivideMap"],
            multMapConfig: "/data/config/ava/mult_map.json",
        };

        this.mapConfig = Object.assign({}, defaults, options.mapConfig || {});
        this._activeIdPath = path.join(this.mapConfig.storagePath, ".active_id");

        // Ensure storage path exists
        try {
            fs.mkdirSync(this.mapConfig.storagePath, {recursive: true});
        } catch (e) {
            Logger.warn("Could not create map storage directory:", e.message);
        }
    }

    /**
     * @returns {Promise<Array<{id: string, name: string, timestamp: number, isActive?: boolean}>>}
     */
    async getMapList() {
        const storagePath = this.mapConfig.storagePath;
        const maps = [];

        try {
            await fs.promises.access(storagePath);
        } catch (_) {
            return maps; // Storage path doesn't exist
        }

        try {
            const entries = await fs.promises.readdir(storagePath, {withFileTypes: true});

            await Promise.all(entries.filter(e => e.isDirectory()).map(async (entry) => {
                const metadataPath = path.join(storagePath, entry.name, "metadata.json");
                let name = entry.name;
                let timestamp = 0;

                try {
                    const meta = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
                    name = meta.name || entry.name;
                    timestamp = meta.timestamp || 0;
                } catch (_) {
                    // metadata missing or unreadable — fall back to directory mtime
                    try {
                        const stat = await fs.promises.stat(path.join(storagePath, entry.name));
                        timestamp = Math.floor(stat.mtimeMs);
                    } catch (_) {
                        // ignore
                    }
                }

                maps.push({
                    id: entry.name,
                    name: name,
                    timestamp: timestamp,
                });
            }));
        } catch (e) {
            Logger.error("Failed to list maps:", e.message);
        }

        // Sort by timestamp descending (newest first)
        maps.sort((a, b) => b.timestamp - a.timestamp);

        // Mark the currently active floor slot
        const activeId = this._getActiveId();
        for (const m of maps) {
            m.isActive = (activeId !== null && m.id === activeId);
        }

        return maps;
    }

    /**
     * @param {string} name
     * @returns {Promise<{id: string, name: string}>}
     */
    async saveMap(name) {
        const id = this._generateId(name);
        const targetDir = path.join(this.mapConfig.storagePath, id);

        Logger.info(`Saving current map as "${name}" (id: ${id})`);

        try {
            // Create target directory
            fs.mkdirSync(targetDir, {recursive: true});

            // Copy each map directory
            for (const dir of this.mapConfig.mapDirs) {
                if (fs.existsSync(dir)) {
                    const dirName = path.basename(dir);
                    const destDir = path.join(targetDir, dirName);
                    // Use cp -a to preserve attributes
                    execSync(`cp -a "${dir}" "${destDir}"`);
                    Logger.info(`  Copied ${dir} → ${destDir}`);
                } else {
                    Logger.warn(`  Map directory ${dir} does not exist, skipping`);
                }
            }

            // Copy mult_map.json if it exists
            if (fs.existsSync(this.mapConfig.multMapConfig)) {
                execSync(`cp -a "${this.mapConfig.multMapConfig}" "${path.join(targetDir, "mult_map.json")}"`);
                Logger.info("  Copied mult_map.json");
            }

            // Write metadata
            const metadata = {
                name: name,
                timestamp: Date.now(),
                id: id,
            };
            fs.writeFileSync(path.join(targetDir, "metadata.json"), JSON.stringify(metadata, null, 2));

            Logger.info(`Map saved successfully: ${name}`);
            return {id: id, name: name};
        } catch (e) {
            // Clean up on failure
            try {
                execSync(`rm -rf "${targetDir}"`);
            } catch (_) {
                // ignore cleanup errors
            }
            Logger.error(`Failed to save map "${name}":`, e.message);
            throw new Error(`Failed to save map: ${e.message}`);
        }
    }

    /**
     * @param {string} id
     * @returns {Promise<void>}
     */
    async loadMap(id) {
        const sourceDir = path.join(this.mapConfig.storagePath, id);

        if (!fs.existsSync(sourceDir)) {
            throw new Error(`Map with id "${id}" not found`);
        }

        // Read metadata for logging
        let mapName = id;
        try {
            const meta = JSON.parse(fs.readFileSync(path.join(sourceDir, "metadata.json"), "utf8"));
            mapName = meta.name || id;
        } catch (_) {
            // ignore — metadata missing or unreadable
        }

        Logger.info(`Loading map "${mapName}" (id: ${id})`);

        // Step 1: Move current map dirs to .loadbak — never delete before restore succeeds
        Logger.info("  Staging current map data for safe swap...");
        const stagedDirs = [];
        for (const dir of this.mapConfig.mapDirs) {
            if (fs.existsSync(dir)) {
                const bak = `${dir}.loadbak`;
                execSync(`mv "${dir}" "${bak}"`);
                stagedDirs.push({active: dir, bak});
            }
        }
        const multMapBak = `${this.mapConfig.multMapConfig}.loadbak`;
        let multMapStaged = false;
        if (fs.existsSync(this.mapConfig.multMapConfig)) {
            execSync(`mv "${this.mapConfig.multMapConfig}" "${multMapBak}"`);
            multMapStaged = true;
        }

        try {
            // Step 2: Copy saved map data to active locations
            Logger.info("  Restoring saved map data...");
            for (const dir of this.mapConfig.mapDirs) {
                const dirName = path.basename(dir);
                const savedDir = path.join(sourceDir, dirName);
                if (fs.existsSync(savedDir)) {
                    execSync(`cp -a "${savedDir}" "${dir}"`);
                    Logger.info(`    Restored ${savedDir} → ${dir}`);
                } else {
                    Logger.warn(`    Saved map does not contain ${dirName}, skipping`);
                }
            }

            // Restore mult_map.json
            const savedMultMap = path.join(sourceDir, "mult_map.json");
            if (fs.existsSync(savedMultMap)) {
                fs.mkdirSync(path.dirname(this.mapConfig.multMapConfig), {recursive: true});
                execSync(`cp -a "${savedMultMap}" "${this.mapConfig.multMapConfig}"`);
                Logger.info("    Restored mult_map.json");
            }

            // Step 3: Restart robot services so the new map is loaded
            Logger.info("  Restarting robot services...");
            await this._restartServices();

            Logger.info(`Map "${mapName}" loaded successfully`);
            this._setActiveId(id);

            // Step 4: Remove staged backups now that restore fully succeeded
            for (const {bak} of stagedDirs) {
                try { execSync(`rm -rf "${bak}"`); } catch (_) {}
            }
            if (multMapStaged) {
                try { execSync(`rm -f "${multMapBak}"`); } catch (_) {}
            }
        } catch (e) {
            // Restore failed — roll back staged backups to preserve original data
            Logger.error(`Failed to load map "${mapName}", rolling back:`, e.message);
            for (const {active, bak} of stagedDirs) {
                try {
                    if (fs.existsSync(active)) { execSync(`rm -rf "${active}"`); }
                    execSync(`mv "${bak}" "${active}"`);
                } catch (rollbackErr) {
                    Logger.error(`  Rollback failed for ${active}:`, rollbackErr.message);
                }
            }
            if (multMapStaged && fs.existsSync(multMapBak)) {
                try {
                    if (fs.existsSync(this.mapConfig.multMapConfig)) {
                        execSync(`rm -f "${this.mapConfig.multMapConfig}"`);
                    }
                    execSync(`mv "${multMapBak}" "${this.mapConfig.multMapConfig}"`);
                } catch (rollbackErr) {
                    Logger.error("  Rollback failed for mult_map.json:", rollbackErr.message);
                }
            }
            throw new Error(`Failed to load map: ${e.message}`);
        }
    }

    /**
     * @param {string} id
     * @returns {Promise<void>}
     */
    async deleteMap(id) {
        const targetDir = path.join(this.mapConfig.storagePath, id);

        if (!fs.existsSync(targetDir)) {
            throw new Error(`Map with id "${id}" not found`);
        }

        Logger.info(`Deleting map backup: ${id}`);

        try {
            execSync(`rm -rf "${targetDir}"`);
            Logger.info(`Map backup "${id}" deleted`);

            // If the deleted slot was the active floor, clear the active marker
            if (this._getActiveId() === id) {
                this._clearActiveId();
            }
        } catch (e) {
            Logger.error(`Failed to delete map "${id}":`, e.message);
            throw new Error(`Failed to delete map: ${e.message}`);
        }
    }

    /**
     * @param {string} id
     * @param {string} newName
     * @returns {Promise<void>}
     */
    async renameMap(id, newName) {
        const targetDir = path.join(this.mapConfig.storagePath, id);
        const metadataPath = path.join(targetDir, "metadata.json");

        if (!fs.existsSync(targetDir)) {
            throw new Error(`Map with id "${id}" not found`);
        }

        Logger.info(`Renaming map "${id}" to "${newName}"`);

        try {
            let metadata = {};
            if (fs.existsSync(metadataPath)) {
                metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
            }
            metadata.name = newName;
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
            Logger.info(`Map "${id}" renamed to "${newName}"`);
        } catch (e) {
            Logger.error(`Failed to rename map "${id}":`, e.message);
            throw new Error(`Failed to rename map: ${e.message}`);
        }
    }

    /**
     * @param {string} id
     * @returns {Promise<{filePath: string, fileName: string}>}
     */
    async exportMap(id) {
        const sourceDir = path.join(this.mapConfig.storagePath, id);

        if (!fs.existsSync(sourceDir)) {
            throw new Error(`Map with id "${id}" not found`);
        }

        // Read metadata for filename
        let mapName = id;
        const metadataPath = path.join(sourceDir, "metadata.json");
        if (fs.existsSync(metadataPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
                mapName = meta.name || id;
            } catch (_) {
                // ignore
            }
        }

        const safeName = mapName.replace(/[^a-zA-Z0-9_-]/g, "_");
        const archiveName = `valetudo_map_${safeName}_${Date.now()}.tar.gz`;
        const archivePath = `/tmp/${archiveName}`;

        Logger.info(`Exporting map "${mapName}" to ${archivePath}`);

        try {
            execSync(`tar -czf "${archivePath}" -C "${this.mapConfig.storagePath}" "${id}"`);
            Logger.info(`Map exported: ${archivePath}`);
            return {filePath: archivePath, fileName: archiveName};
        } catch (e) {
            Logger.error(`Failed to export map "${id}":`, e.message);
            throw new Error(`Failed to export map: ${e.message}`);
        }
    }

    /**
     * @param {Buffer} data
     * @param {string} name
     * @returns {Promise<{id: string, name: string}>}
     */
    async importMap(data, name) {
        const id = this._generateId(name);
        const tempArchive = `/tmp/valetudo_map_import_${Date.now()}.tar.gz`;
        const tempExtractDir = `/tmp/valetudo_map_extract_${Date.now()}`;

        Logger.info(`Importing map as "${name}" (id: ${id})`);

        try {
            // Write uploaded data to temp file
            fs.writeFileSync(tempArchive, data);

            // Extract to temp directory first to validate
            fs.mkdirSync(tempExtractDir, {recursive: true});
            execSync(`tar -xzf "${tempArchive}" -C "${tempExtractDir}"`);

            // Find the extracted directory (should be a single directory inside)
            const extracted = fs.readdirSync(tempExtractDir, {withFileTypes: true})
                .filter(e => e.isDirectory());

            if (extracted.length === 0) {
                throw new Error("Archive does not contain a valid map directory");
            }

            const extractedDir = path.join(tempExtractDir, extracted[0].name);

            // Validate that it looks like a map backup (should contain at least one of ri, map, DivideMap)
            const hasMapData = ["ri", "map", "DivideMap"].some(
                d => fs.existsSync(path.join(extractedDir, d))
            );

            if (!hasMapData) {
                throw new Error("Archive does not contain valid map data (expected ri, map, or DivideMap directories)");
            }

            // Move to permanent storage
            const targetDir = path.join(this.mapConfig.storagePath, id);
            execSync(`rm -rf "${targetDir}"`);
            execSync(`mv "${extractedDir}" "${targetDir}"`);

            // Update metadata
            const metadata = {
                name: name,
                timestamp: Date.now(),
                id: id,
                imported: true,
            };
            fs.writeFileSync(path.join(targetDir, "metadata.json"), JSON.stringify(metadata, null, 2));

            Logger.info(`Map "${name}" imported successfully`);

            // Cleanup
            try {
                execSync(`rm -rf "${tempArchive}" "${tempExtractDir}"`);
            } catch (_) {
                // ignore cleanup errors
            }

            return {id: id, name: name};
        } catch (e) {
            // Cleanup on failure — remove both the archive and the extract dir
            try {
                execSync(`rm -rf "${tempArchive}" "${tempExtractDir}"`);
            } catch (_) {
                // ignore
            }
            Logger.error(`Failed to import map "${name}":`, e.message);
            throw new Error(`Failed to import map: ${e.message}`);
        }
    }

    /**
     * Restart AVA and related robot services so the new map is picked up.
     * Similar to what pkoehlers/maploader does.
     *
     * @private
     * @returns {Promise<void>}
     */
    async _restartServices() {
        return new Promise((resolve) => {
            // Kill ava and related processes — they will be restarted by the init system
            const commands = [
                "killall -9 ava || true",
                "killall -9 ava_agent || true",
            ];

            exec(commands.join(" && "), {timeout: 10000}, (error) => {
                if (error) {
                    Logger.warn("Service restart had warnings:", error.message);
                }

                // Give processes time to restart
                setTimeout(() => {
                    Logger.info("Services restart initiated");

                    // Also trigger Valetudo to re-poll the map
                    try {
                        this.robot.clearValetudoMap();
                        this.robot.pollMap();
                    } catch (e) {
                        Logger.warn("Could not trigger map re-poll:", e.message);
                    }

                    resolve();
                }, 3000);
            });
        });
    }

    /**
     * @private
     * @returns {string|null}
     */
    _getActiveId() {
        try {
            return fs.readFileSync(this._activeIdPath, "utf8").trim() || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * @private
     * @param {string} id
     */
    _setActiveId(id) {
        try {
            fs.writeFileSync(this._activeIdPath, id, "utf8");
        } catch (e) {
            Logger.warn("Could not write active floor marker:", e.message);
        }
    }

    /**
     * @private
     */
    _clearActiveId() {
        try {
            fs.unlinkSync(this._activeIdPath);
        } catch (e) {
            // ignore ENOENT
        }
    }

    /**
     * Generate a filesystem-safe ID from a name.
     *
     * @private
     * @param {string} name
     * @returns {string}
     */
    _generateId(name) {
        const safeName = name
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_|_$/g, "")
            .substring(0, 32);

        const timestamp = Date.now().toString(36);
        return `${safeName}_${timestamp}`;
    }
}

module.exports = DreameMapManagementCapability;
