function describe(seq) {
  return seq.videoTracks.concat(seq.audioTracks).map(function (t, i) {
    var label = i < seq.videoTracks.length ? "V" + (t.index + 1) : "A" + (t.index + 1);
    return label + ": " + t.clips.slice().sort(function (a, b) { return a.start - b.start; }).map(function (c) {
      return c.media.name + "[" + c.inPoint.toFixed(3) + "→" + (c.inPoint + c.end - c.start).toFixed(3) + " @ " + c.start.toFixed(3) + "-" + c.end.toFixed(3) + "]";
    }).join(" ");
  }).join("\n");
}
(async function () {
  try {
    var video = new Media("/clips/ramon.mp4", 120, true);
    var music = new Media("/clips/musica.mp3", 300, false);
    var title = new Media("/clips/titulo.png", 5, true);
    project.root = new Folder([video, music, new Folder([title])]);
    var seq = new Sequence("Mi edición");
    project.sequences.push(seq); project.active = seq;
    seq.videoTracks[0].clips.push(new Clip(video, 2, 62, 5, "video"));
    seq.audioTracks[0].clips.push(new Clip(video, 2, 62, 5, "audio"));
    seq.audioTracks[1].clips.push(new Clip(music, 0, 70, 0, "audio"));
    seq.videoTracks[1].clips.push(new Clip(title, 0, 5, 0, "video"));
    video.inMark = 1; video.outMark = 100; // marcas previas del usuario
    var before = describe(seq);
    var kept = [[5, 9.37], [10.12, 18.5], [19.01, 19.4], [25, 40.25], [41, 65]];
    var analysis = {
      clip: { mediaKind: "video", name: "ramon.mp4", mediaPath: "/clips/ramon.mp4", trackIndex: 0, audioTrackIndex: 0,
        startSeconds: 2, endSeconds: 62, inPointSeconds: 5, outPointSeconds: 65, timelineDurationSeconds: 60, sourceToTimelineScale: 1 },
      result: { keptSegments: kept.map(function (k) { return { startSeconds: k[0], endSeconds: k[1], durationSeconds: k[1] - k[0] }; }) }
    };
    var built = await __api.buildSequenceWithoutSilences(project, seq, [analysis], function (m) { log.push("progreso: " + m); });
    print("== Resultado ==");
    print("nombre: " + built.name + " | partes: " + built.pieces + " | duración: " + built.seconds.toFixed(3));
    print("activa: " + project.active.name);
    print(describe(built.sequence));
    print("== Original sin cambios: " + (describe(seq) === before));
    print("== Marcas del clip restauradas: " + video.inMark + " / " + video.outMark);
    // Verificación automática: partes contiguas desde 0 y rangos exactos (a cuadro).
    var v = built.sequence.videoTracks[0].clips.slice().sort(function (a, b) { return a.start - b.start; });
    var a = built.sequence.audioTracks[0].clips.slice().sort(function (a, b) { return a.start - b.start; });
    var ok = v.length === kept.length && a.length === kept.length && built.sequence.videoTracks[1].clips.length === 1 && built.sequence.audioTracks[1].clips.length === kept.length;
    var cursor = 0;
    v.forEach(function (c, i) {
      if (Math.abs(c.start - cursor) > 1e-6) { ok = false; print("hueco/encimado en parte " + (i + 1)); }
      if (Math.abs(c.inPoint - kept[i][0]) > 1e-6) { ok = false; print("entrada mal en parte " + (i + 1)); }
      if (Math.abs((c.end - c.start) - snap(kept[i][1] - kept[i][0])) > 1e-6) { ok = false; print("duración mal en parte " + (i + 1)); }
      if (Math.abs(a[i].start - c.start) > 1e-6 || Math.abs(a[i].end - c.end) > 1e-6) { ok = false; print("audio desfasado en parte " + (i + 1)); }
      cursor = c.end;
    });
    print("== VERIFICACIÓN: " + (ok ? "OK" : "FALLA"));
    print("== Transacciones: " + log.filter(function (l) { return l.indexOf("progreso") < 0; }).length + "; fallas: " + log.filter(function (l) { return l.indexOf("TX FAIL") === 0; }).length);

    // Clip solo de audio (por ejemplo un podcast).
    var voice = new Media("/clips/voz.wav", 50, false);
    project.root.items.push(voice);
    var seq2 = new Sequence("Podcast"); project.sequences.push(seq2); project.active = seq2;
    seq2.audioTracks[0].clips.push(new Clip(voice, 0, 50, 0, "audio"));
    var built2 = await __api.buildSequenceWithoutSilences(project, seq2, [{
      clip: { mediaKind: "audio", name: "voz.wav", mediaPath: "/clips/voz.wav", audioTrackIndex: 0, startSeconds: 0, endSeconds: 50, inPointSeconds: 0, outPointSeconds: 50, sourceToTimelineScale: 1 },
      result: { keptSegments: [{ startSeconds: 1, endSeconds: 10 }, { startSeconds: 12.5, endSeconds: 30 }] }
    }], function () {});
    print("== Solo audio ==");
    print(describe(built2.sequence));
    print("marcas voz: " + voice.inMark + " / " + voice.outMark);
  } catch (e) { print("ERROR: " + e + "\n" + e.stack); }
})();
