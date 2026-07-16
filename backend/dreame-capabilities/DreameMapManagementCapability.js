const fs = require("fs");
const Logger = require("../../../backend/lib/Logger");
const MapManagementCapability = require("../core-capabilities/MapManagementCapability");
const os = require("os");
const path = require("path");
const tar = require("tar-stream");
const {createGunzip} = require("zlib");
const {exec, execFileSync} = require("child_process");
const {Readable} = require("stream");

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10000;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
                const mapDirectory = path.join(storagePath, entry.name);
                let name = entry.name;
                let timestamp = 0;

                try {
                    const meta = this._readMapMetadata(mapDirectory);
                    if (meta !== null) {
                        name = meta.name || entry.name;
                        timestamp = meta.timestamp || 0;
                    }
                } catch (_) {
                    // metadata missing or unreadable — fall back to directory mtime
                    try {
                        const stat = await fs.promises.stat(mapDirectory);
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
        const targetDir = this._resolveMapDirectory(id, false);

        if (fs.existsSync(targetDir)) {
            throw new Error(`Map with id "${id}" already exists`);
        }

        Logger.info(`Saving current map as "${name}" (id: ${id})`);

        try {
            // Create target directory
            fs.mkdirSync(targetDir, {recursive: true});

            // Copy each map directory
            for (const dir of this.mapConfig.mapDirs) {
                if (fs.existsSync(dir)) {
                    const dirName = path.basename(dir);
                    const destDir = path.join(targetDir, dirName);
                    fs.cpSync(dir, destDir, {recursive: true, preserveTimestamps: true});
                    Logger.info(`  Copied ${dir} → ${destDir}`);
                } else {
                    Logger.warn(`  Map directory ${dir} does not exist, skipping`);
                }
            }

            // Copy mult_map.json if it exists
            if (fs.existsSync(this.mapConfig.multMapConfig)) {
                fs.copyFileSync(this.mapConfig.multMapConfig, path.join(targetDir, "mult_map.json"));
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
                fs.rmSync(targetDir, {recursive: true, force: true});
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
        const sourceDir = this._resolveMapDirectory(id, true);
        this._assertSafeMapTree(sourceDir);

        // Read metadata for logging
        let mapName = id;
        try {
            const meta = this._readMapMetadata(sourceDir);
            mapName = meta?.name || id;
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
                fs.renameSync(dir, bak);
                stagedDirs.push({active: dir, bak: bak});
            }
        }
        const multMapBak = `${this.mapConfig.multMapConfig}.loadbak`;
        let multMapStaged = false;
        if (fs.existsSync(this.mapConfig.multMapConfig)) {
            fs.renameSync(this.mapConfig.multMapConfig, multMapBak);
            multMapStaged = true;
        }

        try {
            // Step 2: Copy saved map data to active locations
            Logger.info("  Restoring saved map data...");
            for (const dir of this.mapConfig.mapDirs) {
                const dirName = path.basename(dir);
                const savedDir = path.join(sourceDir, dirName);
                if (fs.existsSync(savedDir)) {
                    fs.cpSync(savedDir, dir, {recursive: true, preserveTimestamps: true});
                    Logger.info(`    Restored ${savedDir} → ${dir}`);
                } else {
                    Logger.warn(`    Saved map does not contain ${dirName}, skipping`);
                }
            }

            // Restore mult_map.json
            const savedMultMap = path.join(sourceDir, "mult_map.json");
            if (fs.existsSync(savedMultMap)) {
                fs.mkdirSync(path.dirname(this.mapConfig.multMapConfig), {recursive: true});
                fs.copyFileSync(savedMultMap, this.mapConfig.multMapConfig);
                Logger.info("    Restored mult_map.json");
            }

            // Step 3: Restart robot services so the new map is loaded
            Logger.info("  Restarting robot services...");
            await this._restartServices();

            Logger.info(`Map "${mapName}" loaded successfully`);
            this._setActiveId(id);

            // Step 4: Remove staged backups now that restore fully succeeded
            for (const {bak} of stagedDirs) {
                try {
                    fs.rmSync(bak, {recursive: true, force: true});
                } catch (_) {
                    // ignore cleanup errors after a successful restore
                }
            }
            if (multMapStaged) {
                try {
                    fs.rmSync(multMapBak, {force: true});
                } catch (_) {
                    // ignore cleanup errors after a successful restore
                }
            }
        } catch (e) {
            // Restore failed — roll back staged backups to preserve original data
            Logger.error(`Failed to load map "${mapName}", rolling back:`, e.message);
            for (const {active, bak} of stagedDirs) {
                try {
                    if (fs.existsSync(active)) {
                        fs.rmSync(active, {recursive: true, force: true});
                    }
                    fs.renameSync(bak, active);
                } catch (rollbackErr) {
                    Logger.error(`  Rollback failed for ${active}:`, rollbackErr.message);
                }
            }
            if (multMapStaged && fs.existsSync(multMapBak)) {
                try {
                    if (fs.existsSync(this.mapConfig.multMapConfig)) {
                        fs.rmSync(this.mapConfig.multMapConfig, {force: true});
                    }
                    fs.renameSync(multMapBak, this.mapConfig.multMapConfig);
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
        const targetDir = this._resolveMapDirectory(id, true);

        Logger.info(`Deleting map backup: ${id}`);

        try {
            fs.rmSync(targetDir, {recursive: true});
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
        const targetDir = this._resolveMapDirectory(id, true);
        this._assertSafeMapTree(targetDir);
        const metadataPath = path.join(targetDir, "metadata.json");

        Logger.info(`Renaming map "${id}" to "${newName}"`);

        try {
            let metadata = {};
            if (fs.existsSync(metadataPath)) {
                metadata = this._readMapMetadata(targetDir);
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
        const sourceDir = this._resolveMapDirectory(id, true);
        this._assertSafeMapTree(sourceDir);

        // Read metadata for filename
        let mapName = id;
        try {
            const meta = this._readMapMetadata(sourceDir);
            if (meta !== null) {
                mapName = meta.name || id;
            }
        } catch (_) {
            // ignore invalid metadata contents; unsafe filesystem entries were rejected above
        }

        const safeName = mapName.replace(/[^a-zA-Z0-9_-]/g, "_");
        const archiveName = `valetudo_map_${safeName}_${Date.now()}.tar.gz`;
        const archivePath = `/tmp/${archiveName}`;

        Logger.info(`Exporting map "${mapName}" to ${archivePath}`);

        try {
            execFileSync("tar", ["-czf", archivePath, "-C", this.mapConfig.storagePath, id], {
                env: {...process.env, COPYFILE_DISABLE: "1"},
            });
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
        const tempExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), "valetudo_map_extract_"));
        const storagePath = fs.realpathSync(this.mapConfig.storagePath);
        const stagingParent = fs.mkdtempSync(path.join(storagePath, ".import-"));
        const stagingDir = path.join(stagingParent, "map");
        const targetDir = this._resolveMapDirectory(id, false);

        Logger.info(`Importing map as "${name}" (id: ${id})`);

        try {
            const extractedRoot = await this._extractMapArchive(data, tempExtractDir);
            const extractedDir = path.join(tempExtractDir, extractedRoot);

            // Validate that it looks like a map backup (should contain at least one of ri, map, DivideMap)
            const hasMapData = ["ri", "map", "DivideMap"].some(
                d => {
                    const mapDataPath = path.join(extractedDir, d);
                    try {
                        return fs.lstatSync(mapDataPath).isDirectory();
                    } catch (_) {
                        return false;
                    }
                }
            );

            if (!hasMapData) {
                throw new Error("Archive does not contain valid map data (expected ri, map, or DivideMap directories)");
            }

            // Copy into a staging directory on the storage filesystem, then promote atomically
            fs.cpSync(extractedDir, stagingDir, {recursive: true, preserveTimestamps: true});

            // Update metadata
            const metadata = {
                name: name,
                timestamp: Date.now(),
                id: id,
                imported: true,
            };
            fs.writeFileSync(path.join(stagingDir, "metadata.json"), JSON.stringify(metadata, null, 2));

            if (fs.existsSync(targetDir)) {
                this._resolveMapDirectory(id, true);
                fs.rmSync(targetDir, {recursive: true});
            }
            fs.renameSync(stagingDir, targetDir);

            Logger.info(`Map "${name}" imported successfully`);

            // Cleanup
            try {
                fs.rmSync(tempExtractDir, {recursive: true, force: true});
                fs.rmSync(stagingParent, {recursive: true, force: true});
            } catch (_) {
                // ignore cleanup errors
            }

            return {id: id, name: name};
        } catch (e) {
            // Cleanup on failure
            try {
                fs.rmSync(tempExtractDir, {recursive: true, force: true});
                fs.rmSync(stagingParent, {recursive: true, force: true});
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
     * Resolve a map ID to a real direct child of the configured storage directory.
     *
     * @private
     * @param {string} id
     * @param {boolean} mustExist
     * @returns {string}
     */
    _resolveMapDirectory(id, mustExist) {
        if (typeof id !== "string" || !MAP_ID_PATTERN.test(id)) {
            throw new Error(`Invalid map id "${id}"`);
        }

        const storagePath = fs.realpathSync(this.mapConfig.storagePath);
        const candidate = path.resolve(storagePath, id);
        if (path.dirname(candidate) !== storagePath) {
            throw new Error(`Invalid map id "${id}"`);
        }

        if (!fs.existsSync(candidate)) {
            if (mustExist) {
                throw new Error(`Map with id "${id}" not found`);
            }
            return candidate;
        }

        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink()) {
            throw new Error(`Map with id "${id}" is a symbolic link`);
        }
        if (!stat.isDirectory()) {
            throw new Error(`Map with id "${id}" is not a directory`);
        }

        const realCandidate = fs.realpathSync(candidate);
        if (path.dirname(realCandidate) !== storagePath) {
            throw new Error(`Map with id "${id}" resolves outside map storage`);
        }

        return candidate;
    }

    /**
     * Reject unsafe entries that may remain in maps imported by older vulnerable versions.
     *
     * @private
     * @param {string} mapDirectory
     */
    _assertSafeMapTree(mapDirectory) {
        const root = fs.realpathSync(mapDirectory);
        let entryCount = 0;
        let totalBytes = 0;

        const visit = currentDirectory => {
            for (const entry of fs.readdirSync(currentDirectory, {withFileTypes: true})) {
                entryCount += 1;
                if (entryCount > MAX_ARCHIVE_ENTRIES) {
                    throw new Error(`Unsafe saved map: more than ${MAX_ARCHIVE_ENTRIES} entries`);
                }

                const candidate = path.join(currentDirectory, entry.name);
                const stat = fs.lstatSync(candidate);
                if (stat.isSymbolicLink()) {
                    throw new Error(`Unsafe saved map: symbolic link at "${path.relative(root, candidate)}"`);
                }

                const realCandidate = fs.realpathSync(candidate);
                if (realCandidate !== root && !realCandidate.startsWith(`${root}${path.sep}`)) {
                    throw new Error("Unsafe saved map: entry resolves outside map directory");
                }

                if (stat.isDirectory()) {
                    visit(candidate);
                } else if (stat.isFile()) {
                    totalBytes += stat.size;
                    if (totalBytes > MAX_EXTRACTED_BYTES) {
                        throw new Error(`Unsafe saved map: exceeds ${MAX_EXTRACTED_BYTES} bytes`);
                    }
                } else {
                    throw new Error(`Unsafe saved map: unsupported entry at "${path.relative(root, candidate)}"`);
                }
            }
        };

        visit(root);
    }

    /**
     * @private
     * @param {string} mapDirectory
     * @returns {object|null}
     */
    _readMapMetadata(mapDirectory) {
        const metadataPath = path.join(mapDirectory, "metadata.json");
        if (!fs.existsSync(metadataPath)) {
            return null;
        }

        const stat = fs.lstatSync(metadataPath);
        if (stat.isSymbolicLink()) {
            throw new Error("Unsafe saved map metadata: symbolic link");
        }
        if (!stat.isFile()) {
            throw new Error("Unsafe saved map metadata: not a regular file");
        }

        const root = fs.realpathSync(mapDirectory);
        const realMetadataPath = fs.realpathSync(metadataPath);
        if (path.dirname(realMetadataPath) !== root) {
            throw new Error("Unsafe saved map metadata: resolves outside map directory");
        }

        return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    }

    /**
     * Extract a gzip-compressed tar archive while enforcing a strict filesystem boundary.
     *
     * @private
     * @param {Buffer} data
     * @param {string} destinationRoot
     * @returns {Promise<string>} the single extracted top-level directory name
     */
    async _extractMapArchive(data, destinationRoot) {
        if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_ARCHIVE_BYTES) {
            throw new Error(`Archive must be a non-empty gzip file no larger than ${MAX_ARCHIVE_BYTES} bytes`);
        }

        const root = path.resolve(destinationRoot);
        const extract = tar.extract();
        const gunzip = createGunzip();
        const input = Readable.from([data]);
        let entryCount = 0;
        let extractedBytes = 0;
        let topLevel = null;

        return new Promise((resolve, reject) => {
            let settled = false;
            const fail = error => {
                if (settled) {
                    return;
                }
                settled = true;
                input.destroy();
                gunzip.destroy();
                extract.destroy();
                reject(error);
            };

            extract.on("entry", (header, stream, next) => {
                try {
                    entryCount += 1;
                    if (entryCount > MAX_ARCHIVE_ENTRIES) {
                        throw new Error(`Archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`);
                    }
                    if (header.type !== "file" && header.type !== "directory") {
                        throw new Error(`Unsupported archive entry type "${header.type}"`);
                    }

                    const entryName = this._normalizeArchiveEntryName(header.name);
                    const entryTopLevel = entryName.split("/")[0];
                    if (topLevel === null) {
                        topLevel = entryTopLevel;
                    } else if (entryTopLevel !== topLevel) {
                        throw new Error("Archive must contain exactly one top-level directory");
                    }

                    const destination = path.resolve(root, ...entryName.split("/"));
                    if (destination === root || !destination.startsWith(`${root}${path.sep}`)) {
                        throw new Error(`Archive entry "${header.name}" resolves outside extraction directory`);
                    }

                    if (header.type === "directory") {
                        fs.mkdirSync(destination, {
                            recursive: true,
                            mode: ((header.mode || 0o700) & 0o777) | 0o700,
                        });
                        stream.on("error", fail);
                        stream.on("end", next);
                        stream.resume();
                        return;
                    }

                    const size = Number(header.size);
                    if (!Number.isSafeInteger(size) || size < 0) {
                        throw new Error(`Archive entry "${header.name}" has an invalid size`);
                    }
                    extractedBytes += size;
                    if (extractedBytes > MAX_EXTRACTED_BYTES) {
                        throw new Error(`Archive expands beyond ${MAX_EXTRACTED_BYTES} bytes`);
                    }

                    fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
                    const output = fs.createWriteStream(destination, {
                        flags: "wx",
                        mode: (header.mode || 0o600) & 0o777,
                    });
                    stream.on("error", fail);
                    output.on("error", fail);
                    output.on("finish", next);
                    stream.pipe(output);
                } catch (e) {
                    stream.resume();
                    fail(e);
                }
            });
            extract.on("error", fail);
            gunzip.on("error", fail);
            input.on("error", fail);
            extract.on("finish", () => {
                if (settled) {
                    return;
                }
                settled = true;
                if (topLevel === null) {
                    reject(new Error("Archive does not contain a valid map directory"));
                    return;
                }
                const extractedRoot = path.join(root, topLevel);
                try {
                    if (!fs.lstatSync(extractedRoot).isDirectory()) {
                        reject(new Error("Archive top-level entry must be a directory"));
                        return;
                    }
                } catch (_) {
                    reject(new Error("Archive does not contain a valid map directory"));
                    return;
                }
                resolve(topLevel);
            });

            input.pipe(gunzip).pipe(extract);
        });
    }

    /**
     * @private
     * @param {string} name
     * @returns {string}
     */
    _normalizeArchiveEntryName(name) {
        if (typeof name !== "string" || name.length === 0 || name.includes("\0") || name.includes("\\")) {
            throw new Error("Archive contains an invalid entry name");
        }

        let canonical = name.replace(/\/+$/g, "");
        while (canonical.startsWith("./")) {
            canonical = canonical.substring(2);
        }
        if (canonical.length === 0 || path.posix.isAbsolute(canonical) || /^[a-zA-Z]:/.test(canonical)) {
            throw new Error(`Archive contains unsafe entry path "${name}"`);
        }

        const normalized = path.posix.normalize(canonical);
        if (normalized === ".." || normalized.startsWith("../") || normalized !== canonical) {
            throw new Error(`Archive contains unsafe entry path "${name}"`);
        }

        return normalized;
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
            .substring(0, 32) || "map";

        const timestamp = Date.now().toString(36);
        return `${safeName}_${timestamp}`;
    }
}

module.exports = DreameMapManagementCapability;
