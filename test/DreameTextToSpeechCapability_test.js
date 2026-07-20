const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {EventEmitter} = require("node:events");
const {Readable} = require("node:stream");

const DreameTextToSpeechCapability = require("../backend/dreame-capabilities/DreameTextToSpeechCapability");
const TextToSpeechCapabilityBusyError = require("../backend/core-capabilities/TextToSpeechCapabilityBusyError");
const TextToSpeechCapabilityRouter = require("../backend/capability-routers/TextToSpeechCapabilityRouter");

function createCapability(t, config = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "valetudo-tts-test-"));
    t.after(() => fs.rmSync(tempDir, {recursive: true, force: true}));

    return new DreameTextToSpeechCapability({
        robot: {},
        ttsConfig: Object.assign({tempDir: tempDir}, config)
    });
}

function immediate() {
    return new Promise(resolve => setImmediate(resolve));
}

test("rejects overlapping speech while preserving the first job", async t => {
    const capability = createCapability(t);
    let releaseDownload;
    let activeDownloads = 0;
    let peakDownloads = 0;
    const downloadGate = new Promise(resolve => {
        releaseDownload = resolve;
    });

    capability._downloadTTSAudio = async () => {
        activeDownloads++;
        peakDownloads = Math.max(peakDownloads, activeDownloads);
        await downloadGate;
        activeDownloads--;
    };
    capability._convertToWav = async () => undefined;
    capability._playAudio = async () => undefined;

    const jobs = Array.from({length: 25}, (_, index) => capability.speak(`message-${index}`));
    const resultsPromise = Promise.allSettled(jobs);
    await immediate();
    releaseDownload();

    const results = await resultsPromise;
    assert.equal(peakDownloads, 1);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.reason instanceof TextToSpeechCapabilityBusyError).length, 24);
});

test("allows sequential speech after a completed job", async t => {
    const capability = createCapability(t);
    let downloads = 0;

    capability._downloadTTSAudio = async () => {
        downloads++;
    };
    capability._convertToWav = async () => undefined;
    capability._playAudio = async () => undefined;

    await capability.speak("first");
    await capability.speak("second");

    assert.equal(downloads, 2);
    assert.equal((await capability.getStatus()).speaking, false);
    assert.deepEqual(fs.readdirSync(capability.ttsConfig.tempDir), []);
});

test("uses the same exclusive gate for local audio files", async t => {
    const capability = createCapability(t);
    const audioFile = path.join(capability.ttsConfig.tempDir, "test.wav");
    fs.writeFileSync(audioFile, "audio");
    let releasePlayback;
    const playbackGate = new Promise(resolve => {
        releasePlayback = resolve;
    });

    capability._playAudio = async () => playbackGate;

    const playback = capability.playAudioFile(audioFile);
    await immediate();
    await assert.rejects(capability.speak("overlap"), TextToSpeechCapabilityBusyError);
    releasePlayback();
    await playback;
});

test("stop cancels an active speech job and releases the gate", async t => {
    const capability = createCapability(t);
    capability._stopPlaybackProcesses = () => undefined;

    capability._downloadTTSAudio = async (text, language, outputPath, signal) => {
        await new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("TTS operation cancelled")), {once: true});
        });
    };

    const speech = capability.speak("cancel me");
    const cancellation = assert.rejects(speech, /TTS operation cancelled/);
    await immediate();
    await capability.stopAudio();
    await cancellation;

    capability._downloadTTSAudio = async () => undefined;
    capability._convertToWav = async () => undefined;
    capability._playAudio = async () => undefined;
    await capability.speak("after cancellation");
});

test("times out stalled downloads without exposing request data", async t => {
    const capability = createCapability(t, {downloadTimeoutMs: 100});
    const request = new EventEmitter();
    request.destroy = () => undefined;
    t.mock.method(https, "get", () => request);

    await assert.rejects(
        capability.speak("private announcement"),
        error => {
            assert.match(error.message, /timed out after 100ms/);
            assert.doesNotMatch(error.message, /private announcement|translate\.google/);
            return true;
        }
    );
    assert.deepEqual(fs.readdirSync(capability.ttsConfig.tempDir), []);
});

test("uses one timeout deadline across a redirect", async t => {
    const capability = createCapability(t, {downloadTimeoutMs: 100});
    let requests = 0;
    t.mock.method(https, "get", (url, options, callback) => {
        requests++;
        const request = new EventEmitter();
        request.destroy = () => undefined;

        if (requests === 1) {
            const response = new EventEmitter();
            response.statusCode = 302;
            response.headers = {location: "https://redirect.invalid/audio"};
            response.destroy = () => undefined;
            response.resume = () => undefined;
            setImmediate(() => callback(response));
        }

        return request;
    });

    await assert.rejects(capability.speak("redirected"), /timed out after 100ms/);
    assert.equal(requests, 2);
});

test("downloads a redirected response and removes its temporary job directory", async t => {
    const capability = createCapability(t);
    let requests = 0;
    let downloadedAudio;
    t.mock.method(https, "get", (url, options, callback) => {
        requests++;
        const request = new EventEmitter();
        request.destroy = () => undefined;
        const response = requests === 1 ? Readable.from([]) : Readable.from(["audio-data"]);
        response.statusCode = requests === 1 ? 302 : 200;
        response.headers = requests === 1 ? {location: "https://redirect.invalid/audio"} : {};
        setImmediate(() => callback(response));
        return request;
    });
    capability._convertToWav = async mp3Path => {
        downloadedAudio = fs.readFileSync(mp3Path, "utf8");
    };
    capability._playAudio = async () => undefined;

    await capability.speak("successful redirect");

    assert.equal(requests, 2);
    assert.equal(downloadedAudio, "audio-data");
    assert.deepEqual(fs.readdirSync(capability.ttsConfig.tempDir), []);
});

test("validates the configured download timeout", () => {
    assert.throws(
        () => new DreameTextToSpeechCapability({robot: {}, ttsConfig: {downloadTimeoutMs: 99}}),
        /downloadTimeoutMs must be an integer between 100 and 120000/
    );
});

test("maps busy audio operations to HTTP 409", () => {
    const router = new TextToSpeechCapabilityRouter({
        capability: {},
        validator: (req, res, next) => next()
    });
    const response = {
        body: undefined,
        statusCode: undefined,
        status: function(code) {
            this.statusCode = code;
            return this;
        },
        json: function(body) {
            this.body = body;
        }
    };

    router.sendAudioErrorResponse({body: {}, path: "/"}, response, new TextToSpeechCapabilityBusyError());

    assert.equal(response.statusCode, 409);
    assert.equal(response.body, "TTS is busy");
});
