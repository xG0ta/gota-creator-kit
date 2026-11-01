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

/* ---- Subtítulos y silencios (3.3.12) ----
 * ExtendScript antiguo: sin let/const ni funciones flecha.
 */
var GOTA_TICKS_PER_SECOND = 254016000000;
var GOTA_CAPTION_BIN = 'Gota Subtítulos';

$._GotaLegacy._fail = function (message) {
  return $._GotaLegacy._json({ ok: false, message: message });
};

$._GotaLegacy.sequenceInfo = function () {
  var sequence = app.project.activeSequence;
  if (!sequence) return $._GotaLegacy._fail('Abre una secuencia.');
  var timebase = Number(sequence.timebase) || 0;
  var fps = timebase > 0 ? GOTA_TICKS_PER_SECOND / timebase : 30;
  return $._GotaLegacy._json({
    ok: true,
    name: sequence.name,
    width: Number(sequence.frameSizeHorizontal) || 1080,
    height: Number(sequence.frameSizeVertical) || 1920,
    fps: fps > 0 && fps <= 120 ? fps : 30
  });
};

// Clips seleccionados con su tramo de la fuente y su lugar en la línea de tiempo.
$._GotaLegacy.selectedClips = function () {
  try {
    var sequence = app.project.activeSequence;
    if (!sequence) return $._GotaLegacy._fail('Abre una secuencia.');
    var selection = sequence.getSelection();
    var clips = [];
    for (var index = 0; index < selection.length; index += 1) {
      var item = selection[index];
      if (!item || !item.projectItem) continue;
      var mediaPath = '';
      try { mediaPath = item.projectItem.getMediaPath(); } catch (_) { mediaPath = ''; }
      if (!mediaPath) continue;
      var speed = 1;
      try { speed = Math.abs(Number(item.getSpeed()) || 1); } catch (_) { speed = 1; }
      clips.push({
        name: item.name,
        mediaPath: mediaPath,
        mediaKind: String(item.mediaType || '').toLowerCase(),
        nodeId: item.projectItem.nodeId,
        startSeconds: item.start.seconds,
        endSeconds: item.end.seconds,
        inPointSeconds: item.inPoint.seconds,
        outPointSeconds: item.outPoint.seconds,
        speed: speed
      });
    }
    return $._GotaLegacy._json({ ok: true, clips: clips });
  } catch (error) {
    return $._GotaLegacy._fail('No pude leer la selección: ' + error.toString());
  }
};

$._GotaLegacy._captionBin = function () {
  var root = app.project.rootItem;
  for (var index = 0; index < root.children.numItems; index += 1) {
    var child = root.children[index];
    if (child.name === GOTA_CAPTION_BIN && child.type === ProjectItemType.BIN) return child;
  }
  return root.createBin(GOTA_CAPTION_BIN) || root;
};

$._GotaLegacy._trackFreeBetween = function (track, start, end) {
  for (var index = 0; index < track.clips.numItems; index += 1) {
    var clip = track.clips[index];
    if (clip.start.seconds < end && clip.end.seconds > start) return false;
  }
  return true;
};

// Coloca los videos transparentes de subtítulos (uno por línea) en una pista
// de video libre; si no hay, agrega una arriba.
$._GotaLegacy.placeCaptionClips = function (payloadText) {
  try {
    var sequence = app.project.activeSequence;
    if (!sequence) return $._GotaLegacy._fail('Abre la secuencia donde van los subtítulos.');
    var payload = JSON.parse(payloadText);
    var lines = payload.lines || [];
    if (!lines.length) return $._GotaLegacy._fail('No hay subtítulos para colocar.');
    var first = lines[0].startSeconds;
    var last = lines[lines.length - 1].endSeconds;
    var trackIndex = -1;
    for (var index = 1; index < sequence.videoTracks.numTracks; index += 1) {
      if ($._GotaLegacy._trackFreeBetween(sequence.videoTracks[index], first, last)) { trackIndex = index; break; }
    }
    if (trackIndex < 0) {
      app.enableQE();
      qe.project.getActiveSequence().addTracks(1, sequence.videoTracks.numTracks, 0);
      trackIndex = sequence.videoTracks.numTracks - 1;
      if (!$._GotaLegacy._trackFreeBetween(sequence.videoTracks[trackIndex], first, last)) {
        return $._GotaLegacy._fail('No encontré una pista de video libre. Agrega una pista vacía y vuelve a intentar.');
      }
    }
    var bin = $._GotaLegacy._captionBin();
    var paths = [];
    for (index = 0; index < lines.length; index += 1) paths.push(lines[index].path);
    app.project.importFiles(paths, true, bin, false);
    var track = sequence.videoTracks[trackIndex];
    var placed = 0;
    for (index = 0; index < lines.length; index += 1) {
      var item = $._GotaLegacy._findItemByPath(bin, paths[index]) || $._GotaLegacy._findItemByPath(app.project.rootItem, paths[index]);
      if (!item) continue;
      track.overwriteClip(item, lines[index].startSeconds);
      placed += 1;
    }
    if (!placed) return $._GotaLegacy._fail('Premiere no pudo importar los videos de subtítulos.');
    return $._GotaLegacy._json({ ok: true, placed: placed, track: trackIndex + 1 });
  } catch (error) {
    return $._GotaLegacy._fail('No se pudieron colocar los subtítulos: ' + error.toString());
  }
};

$._GotaLegacy._itemByNodeId = function (item, nodeId) {
  if (!item) return null;
  if (item.nodeId === nodeId) return item;
  if (item.children && item.children.numItems) {
    for (var index = 0; index < item.children.numItems; index += 1) {
      var found = $._GotaLegacy._itemByNodeId(item.children[index], nodeId);
      if (found) return found;
    }
  }
  return null;
};

$._GotaLegacy._wasTouched = function (touched, item) {
  for (var index = 0; index < touched.length; index += 1) if (touched[index].item.nodeId === item.nodeId) return true;
  return false;
};

// Arma una secuencia NUEVA solo con las partes con voz. La secuencia original
// no se toca: si algo sale mal, basta con borrar la copia.
$._GotaLegacy.buildWithoutSilences = function (payloadText) {
  var touched = [];
  try {
    var original = app.project.activeSequence;
    if (!original) return $._GotaLegacy._fail('Abre una secuencia.');
    var payload = JSON.parse(payloadText);
    var pieces = payload.pieces || [];
    if (!pieces.length) return $._GotaLegacy._fail('No quedó nada con voz para armar la secuencia.');
    var firstItem = $._GotaLegacy._itemByNodeId(app.project.rootItem, pieces[0].nodeId);
    if (!firstItem) return $._GotaLegacy._fail('No encontré el clip en el proyecto.');
    var created = app.project.createNewSequenceFromClips(original.name + ' - sin silencios', [firstItem], app.project.rootItem);
    if (!created) return $._GotaLegacy._fail('Premiere no pudo crear la secuencia nueva.');
    // La secuencia nueva trae el clip completo: se vacía antes de armarla.
    var trackGroups = [created.videoTracks, created.audioTracks];
    for (var group = 0; group < trackGroups.length; group += 1) {
      for (var t = 0; t < trackGroups[group].numTracks; t += 1) {
        var clips = trackGroups[group][t].clips;
        for (var c = clips.numItems - 1; c >= 0; c -= 1) clips[c].remove(false, false);
      }
    }
    var cursor = 0;
    for (var index = 0; index < pieces.length; index += 1) {
      var piece = pieces[index];
      var item = $._GotaLegacy._itemByNodeId(app.project.rootItem, piece.nodeId);
      if (!item) continue;
      if (!$._GotaLegacy._wasTouched(touched, item)) {
        var saved = { item: item, inSeconds: null, outSeconds: null };
        try { saved.inSeconds = item.getInPoint().seconds; saved.outSeconds = item.getOutPoint().seconds; } catch (_) {}
        touched.push(saved);
      }
      // 4 = todos los tipos de medio (video y audio).
      item.setInPoint(piece.inSeconds, 4);
      item.setOutPoint(piece.outSeconds, 4);
      // Un clip solo de audio va a la pista de audio; el de video lleva su audio.
      (piece.audioOnly ? created.audioTracks[0] : created.videoTracks[0]).overwriteClip(item, cursor);
      cursor += piece.outSeconds - piece.inSeconds;
    }
    return $._GotaLegacy._json({ ok: true, name: created.name, seconds: cursor });
  } catch (error) {
    return $._GotaLegacy._fail('No se pudo armar la secuencia sin silencios: ' + error.toString());
  } finally {
    // Los puntos de entrada y salida del clip vuelven a como estaban.
    for (var i = 0; i < touched.length; i += 1) {
      var entry = touched[i];
      try {
        if (entry.inSeconds === null) { entry.item.clearInPoint(4); entry.item.clearOutPoint(4); }
        else { entry.item.setInPoint(entry.inSeconds, 4); entry.item.setOutPoint(entry.outSeconds, 4); }
      } catch (_) {}
    }
  }
};
