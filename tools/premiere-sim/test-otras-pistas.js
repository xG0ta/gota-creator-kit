function sorted(t) { return t.clips.slice().sort(function (a, b) { return a.start - b.start; }); }
function describe(seq) {
  return seq.videoTracks.map(function (t) { return ["V" + (t.index + 1), t]; }).concat(seq.audioTracks.map(function (t) { return ["A" + (t.index + 1), t]; })).map(function (p) {
    return p[0] + ": " + sorted(p[1]).map(function (c) { return c.media.name + "[" + c.inPoint.toFixed(2) + "→" + (c.inPoint + c.end - c.start).toFixed(2) + " @" + c.start.toFixed(2) + "-" + c.end.toFixed(2) + "]"; }).join(" ");
  }).join("\n");
}
(async function () {
  try {
    var video = new Media("/clips/ramon.mp4", 120, true);
    var music = new Media("/clips/musica.mp3", 300, false);
    var title = new Media("/clips/titulo.png", 5, true, false);
    var text = new Media("", 5, true, false); text.name = "Texto gráfico";
    project.root = new Folder([video, music, title]);
    var seq = new Sequence("Mi edición");
    project.sequences.push(seq); project.active = seq;
    seq.videoTracks[0].clips.push(new Clip(video, 2, 62, 5, "video"));
    seq.audioTracks[0].clips.push(new Clip(video, 2, 62, 5, "audio"));
    seq.audioTracks[1].clips.push(new Clip(music, 0, 70, 10, "audio"));
    seq.videoTracks[1].clips.push(new Clip(title, 0, 5, 0, "video"));
    seq.videoTracks[2].clips.push(new Clip(text, 20, 30, 0, "video"));
    var before = describe(seq);
    var kept = [[5, 9.37], [10.12, 18.5], [25, 40.25], [41, 65]];
    var silences = [[9.37, 10.12], [18.5, 25], [40.25, 41]];
    var analysis = {
      clip: { mediaKind: "video", name: "ramon.mp4", mediaPath: "/clips/ramon.mp4", trackIndex: 0, audioTrackIndex: 0,
        startSeconds: 2, endSeconds: 62, inPointSeconds: 5, outPointSeconds: 65, timelineDurationSeconds: 60, sourceToTimelineScale: 1 },
      result: {
        keptSegments: kept.map(function (k) { return { startSeconds: k[0], endSeconds: k[1] }; }),
        silences: silences.map(function (k) { return { startSeconds: k[0], endSeconds: k[1] }; })
      }
    };
    var n = await __api.markSilencesInSequence(project, seq, [analysis]);
    print("Marcadores: " + n + " → " + seq.markers.map(function (m) { return m.start.toFixed(2) + "+" + m.duration.toFixed(2) + " color " + m.color; }).join(", "));
    n = await __api.markSilencesInSequence(project, seq, [analysis]);
    print("Marcar otra vez no duplica: " + (seq.markers.length === 3));
    print("Quitar: " + (await __api.clearSilenceMarkers(project, seq)) + ", quedan " + seq.markers.length);

    var built = await __api.buildSequenceWithoutSilences(project, seq, [analysis], function () {});
    print("== Resultado (otras pistas recortadas) ==");
    print(describe(built.sequence));
    print("colocadas: " + built.otherPlaced + ", fallidas: " + built.otherFailed + ", omitidas: " + built.skippedOthers);
    var ok = true;
    var v = sorted(built.sequence.videoTracks[0]), mus = sorted(built.sequence.audioTracks[1]);
    var cursor = 0;
    kept.forEach(function (k, i) {
      var c = v[i]; var tA = 2 + (k[0] - 5);
      if (Math.abs(c.start - cursor) > 1e-6 || Math.abs(c.inPoint - k[0]) > 1e-6) { ok = false; print("voz mal " + i); }
      var mm = mus[i];
      if (!mm || Math.abs(mm.start - c.start) > 1e-6 || Math.abs(mm.inPoint - (10 + tA)) > 1e-6 || Math.abs(mm.end - c.end) > 0.04) { ok = false; print("música mal " + i); }
      cursor = c.end;
    });
    var t2 = sorted(built.sequence.videoTracks[1]);
    if (t2.length !== 1 || Math.abs(t2[0].start) > 1e-6 || Math.abs(t2[0].end - 3) > 0.04 || Math.abs(t2[0].inPoint - 2) > 1e-6) { ok = false; print("título mal"); }
    if (built.sequence.videoTracks[2].clips.length !== 0 || built.skippedOthers !== 1) { ok = false; print("texto gráfico mal"); }
    print("Original igual: " + (describe(seq) === before) + " | marcas restauradas: " + [video.inMark, music.inMark, title.inMark].join(","));
    print("== VERIFICACIÓN: " + (ok ? "OK" : "FALLA"));

    project.active = seq;
    var built2 = await __api.buildSequenceWithoutSilences(project, seq, [analysis], function () {}, { includeOtherTracks: false });
    print("== Sin otras pistas ==\n" + describe(built2.sequence));
  } catch (e) { print("ERROR: " + e + "\n" + e.stack); }
})();
