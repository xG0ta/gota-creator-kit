// «Mejores momentos»: cada momento elegido por la IA se arma en su propia
// secuencia nueva (con el nombre del título) y se marca en verde en la
// original. La original no cambia.
function describe(seq) {
  return seq.videoTracks.concat(seq.audioTracks).map(function (t) {
    return t.clips.slice().sort(function (a, b) { return a.start - b.start; }).map(function (c) {
      return c.media.name + "[" + c.inPoint.toFixed(2) + " @ " + c.start.toFixed(2) + "-" + c.end.toFixed(2) + "]";
    }).join(" ");
  }).join("\n");
}
(async function () {
  try {
    var video = new Media("/clips/podcast.mp4", 3600, true);
    var music = new Media("/clips/musica.mp3", 4000, false);
    project.root = new Folder([video, music]);
    var seq = new Sequence("Podcast 12");
    project.sequences.push(seq); project.active = seq;
    // El clip empieza en el segundo 10 de la secuencia y su entrada es el segundo 100 del archivo.
    seq.videoTracks[0].clips.push(new Clip(video, 10, 3010, 100, "video"));
    seq.audioTracks[0].clips.push(new Clip(video, 10, 3010, 100, "audio"));
    seq.audioTracks[1].clips.push(new Clip(music, 0, 3100, 0, "audio"));
    var before = describe(seq);
    var clip = { mediaKind: "video", name: "podcast.mp4", mediaPath: "/clips/podcast.mp4", trackIndex: 0, audioTrackIndex: 0,
      startSeconds: 10, endSeconds: 3010, inPointSeconds: 100, outPointSeconds: 3100, durationSeconds: 3000, sourceToTimelineScale: 1 };
    var moments = [
      { startSeconds: 400, endSeconds: 460, line1: "SE LE PONCHÓ LA LLANTA", line2: "Y UN DESCONOCIDO LO SALVÓ", score: 9, reason: "historia" },
      { startSeconds: 1500.5, endSeconds: 1545, line1: "EL DISCURSO DE LA BODA", line2: "", score: 8, reason: "humor" }
    ];
    var ok = true;
    var count = await __api.markMomentsInSequence(project, seq, clip, moments);
    var marks = seq.markers.filter(function (m) { return /^Momento \d+ \(Gota\)/.test(m.name); });
    print("marcadores: " + count + " -> " + marks.map(function (m) { return m.name + " @" + m.start + " +" + m.duration + " color " + m.color; }).join(" | "));
    if (count !== 2 || marks.length !== 2) { ok = false; print("FALLA: faltan marcadores"); }
    if (Math.abs(marks[0].start - 310) > 1e-6 || Math.abs(marks[0].duration - 60) > 1e-6) { ok = false; print("FALLA: marcador 1 en lugar equivocado"); }
    if (marks.some(function (m) { return m.color !== 0; })) { ok = false; print("FALLA: color"); }
    // Volver a marcar no duplica.
    await __api.markMomentsInSequence(project, seq, clip, moments.slice(0, 1));
    if (seq.markers.filter(function (m) { return /\(Gota\)/.test(m.name); }).length !== 1) { ok = false; print("FALLA: se duplicaron"); }

    for (var i = 0; i < moments.length; i += 1) {
      var m = moments[i];
      var built = await __api.buildSequenceWithoutSilences(project, seq, [{
        clip: clip, result: { keptSegments: [{ startSeconds: m.startSeconds, endSeconds: m.endSeconds }] }
      }], function () {}, { includeOtherTracks: true, copyName: "Podcast 12 - Momento 0" + (i + 1) + " - " + m.line1, openResult: i === moments.length - 1 });
      print("== " + built.name + " (" + built.seconds.toFixed(2) + " s)\n" + describe(built.sequence));
      var v = built.sequence.videoTracks[0].clips;
      var music2 = built.sequence.audioTracks[1].clips;
      if (v.length !== 1 || Math.abs(v[0].inPoint - m.startSeconds) > 0.05 || Math.abs(v[0].start) > 1e-6) { ok = false; print("FALLA: clip mal recortado"); }
      if (Math.abs(built.seconds - (m.endSeconds - m.startSeconds)) > 0.05) { ok = false; print("FALLA: duración"); }
      // La música que sonaba en ese tramo va recortada igual (tiempo de secuencia = 10 + (fuente - 100)).
      if (music2.length !== 1 || Math.abs(music2[0].inPoint - (10 + m.startSeconds - 100)) > 0.05) { ok = false; print("FALLA: música desfasada"); }
      if (built.name.indexOf(m.line1) < 0) { ok = false; print("FALLA: nombre"); }
    }
    print("activa: " + project.active.name);
    if (project.active.name.indexOf("Momento 02") < 0) { ok = false; print("FALLA: no se abrió la última"); }
    if (describe(seq) !== before) { ok = false; print("FALLA: la original cambió"); }
    var removed = await __api.clearMomentMarkers(project, seq);
    if (removed !== 1) { ok = false; print("FALLA: quitar marcadores"); }
    print("== VERIFICACIÓN: " + (ok ? "OK" : "FALLA"));
  } catch (e) { print("ERROR: " + e + "\n" + e.stack); }
})();
