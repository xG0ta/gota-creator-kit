/* Gota Creator Kit Legacy — puente CEP para Premiere Pro 2024. */
$.global._GotaLegacy = $.global._GotaLegacy || {};

$._GotaLegacy._json = function (value) {
  return JSON.stringify(value);
};

$._GotaLegacy.hostInfo = function () {
  var sequence = app.project && app.project.activeSequence;
  return $._GotaLegacy._json({
    version: app.version || '24.x',
    sequence: sequence ? sequence.name : null
  });
};

$._GotaLegacy._findItemByPath = function (item, mediaPath) {
  if (!item) return null;
  try { if (item.getMediaPath && item.getMediaPath() === mediaPath) return item; } catch (_) {}
  if (item.children && item.children.numItems) {
    for (var index = 0; index < item.children.numItems; index += 1) {
      var found = $._GotaLegacy._findItemByPath(item.children[index], mediaPath);
      if (found) return found;
    }
  }
  return null;
};

$._GotaLegacy._firstTrack = function (tracks, atSeconds) {
  for (var index = 0; index < tracks.numTracks; index += 1) {
    var track = tracks[index];
    var occupied = false;
    for (var clipIndex = 0; clipIndex < track.clips.numItems; clipIndex += 1) {
      var clip = track.clips[clipIndex];
      if (clip.start.seconds <= atSeconds && clip.end.seconds > atSeconds) { occupied = true; break; }
    }
    if (!occupied) return index;
  }
  return Math.max(0, tracks.numTracks - 1);
};

$._GotaLegacy.importAtPlayhead = function (mediaPath) {
  try {
    var sequence = app.project.activeSequence;
    if (!sequence) return $._GotaLegacy._json({ ok:false, message:'Abre una secuencia activa antes de añadir el recurso.' });
    var root = app.project.rootItem;
    var item = $._GotaLegacy._findItemByPath(root, mediaPath);
    if (!item) {
      app.project.importFiles([mediaPath], true, root, false);
      item = $._GotaLegacy._findItemByPath(root, mediaPath);
    }
    if (!item) return $._GotaLegacy._json({ ok:false, message:'Premiere no pudo importar el archivo seleccionado.' });
    var time = sequence.getPlayerPosition().seconds;
    var videoTrack = $._GotaLegacy._firstTrack(sequence.videoTracks, time);
    var audioTrack = $._GotaLegacy._firstTrack(sequence.audioTracks, time);
    sequence.insertClip(item, time, videoTrack, audioTrack);
    return $._GotaLegacy._json({ ok:true, message:'Recurso añadido al marcador sin sobrescribir clips existentes.' });
  } catch (error) {
    return $._GotaLegacy._json({ ok:false, message:'No se pudo añadir el recurso: '+error.toString() });
  }
};
