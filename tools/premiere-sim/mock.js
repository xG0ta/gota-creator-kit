// Imitación mínima de la API UXP de Premiere para probar el armado de la
// secuencia sin silencios. Las referencias a clips de la línea de tiempo
// caducan después de cada transacción, como en Premiere real.
var FPS = 30;
var generation = 0;
var log = [];
function snap(s) { return Math.round(s * FPS) / FPS; }
function TT(s) { return { seconds: s, ticks: String(Math.round(s * 254016000000)) }; }
function stale() { throw new Error("The script object is no longer valid."); }

function Media(path, duration, hasVideo, hasAudio) {
  this.path = path; this.duration = duration; this.hasVideo = hasVideo; this.hasAudio = hasAudio !== false;
  this.inMark = null; this.outMark = null; this.name = path.split("/").pop();
}
Media.prototype.getMediaFilePath = async function () { return this.path; };
Media.prototype.getInPoint = async function () { return TT(this.inMark == null ? 0 : this.inMark); };
Media.prototype.getOutPoint = async function () { return TT(this.outMark == null ? this.duration : this.outMark); };
Media.prototype.createSetInOutPointsAction = function (a, b) { var m = this; return { apply: function () { m.inMark = a.seconds; m.outMark = b.seconds; } }; };
Media.prototype.createClearInOutPointsAction = function () { var m = this; return { apply: function () { m.inMark = null; m.outMark = null; } }; };
Media.prototype.createSetNameAction = function (n) { var m = this; return { apply: function () { m.name = n; } }; };

function Folder(items) { this.items = items; this.isFolder = true; }
Folder.prototype.getItems = async function () { return this.items.slice(); };

function Clip(media, start, end, inPoint, kind) { this.media = media; this.start = start; this.end = end; this.inPoint = inPoint; this.kind = kind; this.disabled = false; }

function wrapItem(clip, track) {
  var gen = generation;
  var check = function () { if (gen !== generation || track.clips.indexOf(clip) < 0) stale(); };
  return {
    __clip: clip,
    getStartTime: async function () { check(); return TT(clip.start); },
    getEndTime: async function () { check(); return TT(clip.end); },
    getInPoint: async function () { check(); return TT(clip.inPoint); },
    getOutPoint: async function () { check(); return TT(clip.inPoint + clip.end - clip.start); },
    getProjectItem: async function () { check(); return clip.media; },
    getTrackIndex: async function () { check(); return track.index; },
    getName: async function () { check(); return clip.media.name; },
    getSpeed: async function () { check(); return 1; },
    getMediaType: async function () { check(); return clip.kind === "video" ? "VIDEO" : "AUDIO"; },
    __check: check
  };
}

function Track(index) { this.index = index; this.clips = []; }
Track.prototype.getTrackItems = function () { var t = this; return this.clips.slice().sort(function (a, b) { return a.start - b.start; }).map(function (c) { return wrapItem(c, t); }); };
Track.prototype.overwrite = function (clip) {
  var next = [];
  this.clips.forEach(function (c) {
    if (c.end <= clip.start + 1e-9 || c.start >= clip.end - 1e-9) { next.push(c); return; }
    if (c.start < clip.start) { var head = new Clip(c.media, c.start, clip.start, c.inPoint, c.kind); next.push(head); }
    if (c.end > clip.end) { var tail = new Clip(c.media, clip.end, c.end, c.inPoint + (clip.end - c.start), c.kind); next.push(tail); }
  });
  next.push(clip); this.clips = next;
};

var sequenceCount = 0;
function Sequence(name) {
  this.name = name; this.guid = { toString: function () { return "seq" + (++sequenceCount); } }.toString();
  this.guidValue = this.guid; this.videoTracks = [new Track(0), new Track(1), new Track(2)]; this.markers = []; this.audioTracks = [new Track(0), new Track(1)];
  var s = this; this.guid = { toString: function () { return s.guidValue; } };
  this.projectItem = { createSetNameAction: function (n) { return { apply: function () { s.name = n; } }; } };
}
Sequence.prototype.getVideoTrackCount = async function () { return this.videoTracks.length; };
Sequence.prototype.getAudioTrackCount = async function () { return this.audioTracks.length; };
Sequence.prototype.getVideoTrack = async function (i) { return this.videoTracks[i] || null; };
Sequence.prototype.getAudioTrack = async function (i) { return this.audioTracks[i] || null; };
Sequence.prototype.getProjectItem = async function () { return this.projectItem; };
Sequence.prototype.getTimebase = async function () { return String(254016000000 / FPS); };
Sequence.prototype.createCloneAction = function () {
  var s = this;
  return { apply: function () {
    var copy = new Sequence(s.name + " Copy");
    [["videoTracks", "videoTracks"], ["audioTracks", "audioTracks"]].forEach(function (k) {
      copy[k[0]] = s[k[0]].map(function (t) { var n = new Track(t.index); n.clips = t.clips.map(function (c) { return new Clip(c.media, c.start, c.end, c.inPoint, c.kind); }); return n; });
    });
    project.sequences.push(copy);
  } };
};

var project = {
  sequences: [], active: null, root: null,
  getSequences: async function () { return this.sequences.slice(); },
  getActiveSequence: async function () { return this.active; },
  openSequence: async function (s) { this.active = s; return true; },
  setActiveSequence: async function (s) { this.active = s; return true; },
  getRootItem: async function () { return this.root; },
  lockedAccess: function (fn) { fn(); },
  executeTransaction: function (cb, label) {
    var actions = [];
    try { cb({ addAction: function (a) { if (!a) throw new Error("null action"); actions.push(a); } }); }
    catch (e) { log.push("TX FAIL " + label + ": " + e.message); return false; }
    actions.forEach(function (a) { a.apply(); });
    generation += 1; log.push(label);
    return true;
  }
};

function Editor(seq) { this.seq = seq; }
Editor.prototype.createOverwriteItemAction = function (media, time, v, a) {
  var seq = this.seq;
  return { apply: function () {
    var inP = media.inMark == null ? 0 : media.inMark;
    var outP = media.outMark == null ? media.duration : media.outMark;
    var start = snap(time.seconds), end = start + snap(outP - inP);
    if (v >= 0 && media.hasVideo) seq.videoTracks[v].overwrite(new Clip(media, start, end, inP, "video"));
    if (a >= 0 && media.hasAudio) seq.audioTracks[a].overwrite(new Clip(media, start, end, inP, "audio"));
  } };
};
Editor.prototype.createRemoveItemsAction = function (selection) {
  return { apply: function () {
    selection.items.forEach(function (w) { [].concat(project.sequences).forEach(function (s) { s.videoTracks.concat(s.audioTracks).forEach(function (t) { var i = t.clips.indexOf(w.__clip); if (i >= 0) t.clips.splice(i, 1); }); }); });
  } };
};

function MarkerSet(seq) { this.seq = seq; }
MarkerSet.prototype.getMarkers = function () { return this.seq.markers.map(function (m) { return { __m: m, getName: async function () { return m.name; }, createSetColorByIndexAction: function (i) { return { apply: function () { m.color = i; } }; } }; }); };
MarkerSet.prototype.createAddMarkerAction = function (name, type, start, duration, comments) { var s = this.seq; return { apply: function () { s.markers.push({ name: name, type: type, start: start.seconds, duration: duration.seconds, comments: comments, color: 0 }); } }; };
MarkerSet.prototype.createRemoveMarkerAction = function (w) { var s = this.seq; return { apply: function () { var i = s.markers.indexOf(w.__m); if (i >= 0) s.markers.splice(i, 1); } }; };
var ppro = {
  Markers: { getMarkers: async function (seq) { return new MarkerSet(seq); } },
  TickTime: { createWithSeconds: TT },
  Constants: { TrackItemType: { CLIP: 1 }, MediaType: { VIDEO: "VIDEO", AUDIO: "AUDIO", ANY: "ANY" } },
  ClipProjectItem: { cast: function (x) { if (!x || !x.path) throw new Error("not a clip"); return x; } },
  FolderItem: { cast: function (x) { if (!x || !x.isFolder) throw new Error("not a folder"); return x; } },
  SequenceEditor: { getEditor: function (s) { return new Editor(s); } },
  Project: { getActiveProject: async function () { return project; } },
  TrackItemSelection: { createEmptySelection: function (cb) { var sel = { items: [], addItem: function (w) { w.__check(); this.items.push(w); return true; } }; cb(sel); } },
  SourceMonitor: { closeAllClips: async function () { log.push("source monitor closed"); } }
};
var require = function (name) {
  if (name === "premierepro") return ppro;
  if (name === "uxp") return { entrypoints: { setup: function () {} }, shell: {}, storage: { localFileSystem: {} } };
  return {};
};
var fetch = async function () { throw new Error("sin motor"); };
