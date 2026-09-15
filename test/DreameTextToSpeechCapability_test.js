const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
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

test("notifies onSpeakingChanged listeners on every start and stop, but not on a no-op stop", async t => {
    const capability = createCapability(t);
    const transitions = [];
    capability.onSpeakingChanged(speaking => transitions.push(speaking));

    capability._downloadTTSAudio = async () => undefined;
    capability._convertToWav = async () => undefined;
    capability._playAudio = async () => undefined;

    await capability.speak("first");
    assert.deepEqual(transitions, [true, false]);

    // Nothing is playing, so this must not re-publish an already-false state
    await capability.stopAudio();
    assert.deepEqual(transitions, [true, false]);
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

/**
 * @param {import("node:test").TestContext} t
 * @param {Array<Error|null>} [results] callback error for each successive call
 */
function mockExecFile(t, results = []) {
    const calls = [];
    t.mock.method(childProcess, "execFile", (command, args, callback) => {
        const result = results[calls.length] ?? null;
        calls.push({command: command, args: args});
        setImmediate(() => callback(result));
        return {kill: () => undefined};
    });
    return calls;
}

test("plays a file with shell metacharacters as a single argument without a shell", async t => {
    const capability = createCapability(t);
    const calls = mockExecFile(t);
    const hostile = path.join(capability.ttsConfig.tempDir, "a\"; touch pwned; $(id) \".wav");
    fs.writeFileSync(hostile, "audio");

    await capability.playAudioFile(hostile);

    assert.deepEqual(calls, [{command: "aplay", args: [hostile]}]);
});

test("never passes a relative path that could be read as a player option", async t => {
    const capability = createCapability(t);
    const calls = mockExecFile(t);

    await capability._playAudio("-D.wav", new AbortController().signal);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.length, 1);
    assert.ok(path.isAbsolute(calls[0].args[0]));
});

test("falls back from mpg123 to ffplay for MP3 files", async t => {
    const capability = createCapability(t);
    const mp3 = path.join(capability.ttsConfig.tempDir, "speech.mp3");
    const calls = mockExecFile(t, [new Error("mpg123 missing")]);

    await capability._playAudio(mp3, new AbortController().signal);

    assert.deepEqual(calls, [
        {command: "mpg123", args: ["-q", mp3]},
        {command: "ffplay", args: ["-nodisp", "-autoexit", mp3]}
    ]);
});

test("converts with ffmpeg arguments and falls back to the MP3 without ffmpeg", async t => {
    const capability = createCapability(t);
    const mp3 = path.join(capability.ttsConfig.tempDir, "speech \"$(id)\".mp3");
    const wav = path.join(capability.ttsConfig.tempDir, "speech.wav");
    fs.writeFileSync(mp3, "mp3-data");
    const calls = mockExecFile(t, [Object.assign(new Error("not found"), {code: "ENOENT"})]);

    await capability._convertToWav(mp3, wav, new AbortController().signal);

    assert.deepEqual(calls, [{command: "ffmpeg", args: ["-y", "-i", mp3, "-ar", "16000", "-ac", "1", "-f", "wav", wav]}]);
    assert.equal(fs.readFileSync(wav, "utf8"), "mp3-data");
});

test("stopping tries to end both the player and ffmpeg", t => {
    const capability = createCapability(t, {playerCommand: "aplay"});
    const killed = [];
    t.mock.method(childProcess, "execFileSync", (command, args) => {
        killed.push([command, ...args]);
        throw new Error("no process");
    });

    capability._stopPlaybackProcesses();

    assert.deepEqual(killed, [["killall", "aplay"], ["killall", "ffmpeg"]]);
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
