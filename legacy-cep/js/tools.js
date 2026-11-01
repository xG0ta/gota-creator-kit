/* Subtítulos y silencios para Premiere 2021–2025.5 (desde 3.3.12).
 *
 * El trabajo pesado lo hace el motor local (el mismo del panel moderno):
 * transcribe, analiza silencios y entrega cada línea de subtítulo como un
 * video transparente con su animación. Premiere solo importa y coloca, así
 * que no depende de las APIs nuevas de keyframes.
 */
(function () {
  var SERVICE = 'http://127.0.0.1:8765';
  var cep = window.__adobe_cep__;
  var $ = function (id) { return document.getElementById(id); };
  var lines = [];
  var STYLES = {
    'gota-pop': { fontSize: 46, strokeColor: '#072944', strokeSize: 2, shadowColor: '#001828', shadowBlur: 8, shadowOffset: 2, accent: '#20b7ff' },
    impact: { fontSize: 52, strokeColor: '#161616', strokeSize: 1, shadowColor: '#000000', shadowBlur: 4, shadowOffset: 2, accent: '#f5cc38' },
    minimal: { fontSize: 42, strokeColor: '#000000', strokeSize: 2, shadowColor: '#000000', shadowBlur: 5, shadowOffset: 2, accent: '#ffffff' }
  };

  function host(script) {
    return new Promise(function (resolve, reject) {
      if (!cep || !cep.evalScript) { reject(new Error('Este panel necesita Premiere.')); return; }
      cep.evalScript(script, function (result) {
        try {
          var data = JSON.parse(result);
          if (data && data.ok === false) reject(new Error(data.message)); else resolve(data);
        } catch (_) { reject(new Error('Premiere no respondió: ' + result)); }
      });
    });
  }
  function api(path, body) {
    return fetch(SERVICE + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) throw new Error(payload.detail || ('Motor local: error ' + response.status));
        return payload;
      });
    }, function () { throw new Error('El motor local no responde. Ejecuta el instalador completo de Gota Creator Kit.'); });
  }
  function say(id, text, isError) { var node = $(id); node.textContent = text; node.className = isError ? 'status error' : 'status'; }
  function busy(button, value, label) { button.disabled = value; if (label) button.textContent = label; }
  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  // Video y su audio vinculado (o ángulos de multicámara) ocupan el mismo
  // momento: se usa solo uno para no repetir texto ni cortes.
  function pickClips(clips) {
    var ordered = clips.slice().sort(function (a, b) {
      return a.startSeconds - b.startSeconds || (a.mediaKind === 'audio') - (b.mediaKind === 'audio');
    });
    var picked = [];
    ordered.forEach(function (clip) {
      var length = Math.max(0.001, clip.endSeconds - clip.startSeconds);
      var overlaps = picked.some(function (other) {
        return Math.min(clip.endSeconds, other.endSeconds) - Math.max(clip.startSeconds, other.startSeconds) > length * 0.5;
      });
      if (!overlaps) picked.push(clip);
    });
    return picked;
  }
  function selected() {
    return host('$._GotaLegacy.selectedClips()').then(function (data) {
      var clips = pickClips(data.clips || []);
      if (!clips.length) throw new Error('Selecciona en la línea de tiempo los clips con voz.');
      return clips;
    });
  }
  function scaleOf(clip) {
    return (clip.endSeconds - clip.startSeconds) / Math.max(0.001, clip.outPointSeconds - clip.inPointSeconds);
  }

  // ---------- Subtítulos ----------
  function splitLines(segments, maximum) {
    var limit = Math.max(2, Math.min(16, Math.round(Number(maximum) || 6)));
    var result = [];
    segments.forEach(function (segment) {
      var words = String(segment.text || '').trim().split(/\s+/).filter(Boolean);
      var timed = (segment.words || []).filter(function (word) { return String(word.text || '').trim(); });
      if (words.length <= limit) { result.push({ startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, text: words.join(' '), words: timed }); return; }
      var duration = Math.max(0.1, segment.endSeconds - segment.startSeconds);
      for (var first = 0; first < words.length; first += limit) {
        var last = Math.min(words.length, first + limit);
        var chunk = timed.slice(first, last);
        result.push({
          startSeconds: chunk.length ? chunk[0].startSeconds : segment.startSeconds + duration * first / words.length,
          endSeconds: chunk.length ? chunk[chunk.length - 1].endSeconds : segment.startSeconds + duration * last / words.length,
          text: words.slice(first, last).join(' '),
          words: chunk
        });
      }
    });
    return result;
  }
  // Igual que buildCaptionUnits del panel moderno, pero agrupado por línea.
  function lineUnits(line, highlight) {
    var text = String(line.text || '').trim();
    var start = line.startSeconds, end = line.endSeconds;
    var words = text.split(/\s+/).filter(Boolean);
    if (!highlight) return [{ text: text, startSeconds: start, endSeconds: end, highlightIndex: -1, lineStart: true }];
    var starts;
    if ((line.words || []).length === words.length) {
      starts = line.words.map(function (word) { return Number(word.startSeconds); });
    } else {
      var total = words.reduce(function (sum, word) { return sum + word.length; }, 0) || 1;
      var elapsed = 0;
      starts = words.map(function (word) { var at = start + (end - start) * elapsed / total; elapsed += word.length; return at; });
    }
    var minimum = Math.min(0.04, (end - start) / words.length);
    var previous = start;
    starts = starts.map(function (value, index) {
      if (index === 0) return start;
      var wanted = isFinite(value) ? value : previous + minimum;
      previous = Math.min(end - minimum * (words.length - index), Math.max(previous + minimum, wanted));
      return previous;
    });
    return words.map(function (_, index) {
      return { text: text, startSeconds: starts[index], endSeconds: index + 1 < words.length ? starts[index + 1] : end,
               highlightIndex: index, lineStart: index === 0 };
    });
  }
  function renderLines() {
    var box = $('cap-lines');
    box.innerHTML = '';
    lines.forEach(function (line) {
      var input = document.createElement('input');
      input.value = line.text;
      input.oninput = function () { line.text = input.value; line.words = []; };
      box.appendChild(input);
    });
    box.style.display = lines.length ? 'grid' : 'none';
    $('cap-place').disabled = !lines.length;
  }
  function transcribe() {
    var button = $('cap-transcribe');
    busy(button, true, 'Transcribiendo…');
    say('cap-status', 'Leyendo la selección…');
    var segments = [];
    selected().then(function (clips) {
      var chain = Promise.resolve();
      clips.forEach(function (clip, index) {
        chain = chain.then(function () {
          say('cap-status', 'Transcribiendo' + (clips.length > 1 ? ' clip ' + (index + 1) + ' de ' + clips.length : '') + '… La primera vez tarda unos minutos.');
          return api('/v1/transcribe', { mediaPath: clip.mediaPath, startSeconds: clip.inPointSeconds, endSeconds: clip.outPointSeconds,
                                         language: $('cap-language').value, model: 'small' });
        }).then(function (payload) {
          var scale = scaleOf(clip);
          var toTimeline = function (seconds) { return clip.startSeconds + (Number(seconds) - clip.inPointSeconds) * scale; };
          (payload.segments || []).forEach(function (segment) {
            segments.push({
              startSeconds: Math.max(clip.startSeconds, toTimeline(segment.startSeconds)),
              endSeconds: Math.min(clip.endSeconds, toTimeline(segment.endSeconds)),
              text: String(segment.text || ''),
              words: (segment.words || []).map(function (word) {
                return { text: String(word.text || ''), startSeconds: toTimeline(word.startSeconds), endSeconds: toTimeline(word.endSeconds) };
              })
            });
          });
        });
      });
      return chain;
    }).then(function () {
      segments = segments.filter(function (segment) { return segment.endSeconds > segment.startSeconds; })
        .sort(function (a, b) { return a.startSeconds - b.startSeconds; });
      lines = splitLines(segments, $('cap-words').value);
      renderLines();
      say('cap-status', lines.length ? 'Listo: ' + lines.length + ' líneas. Corrige lo que quieras y toca «Colocar en la secuencia».'
                                     : 'No detecté voz en lo seleccionado.', !lines.length);
    }).catch(function (error) { say('cap-status', error.message, true); })
      .then(function () { busy(button, false, 'Generar subtítulos'); });
  }
  function currentStyle(info) {
    var name = $('cap-style').value;
    var base = STYLES[name];
    return {
      style: name, font: $('cap-font').value, fontSize: Number($('cap-size').value), case: $('cap-case').value,
      verticalPosition: Number($('cap-position').value), alignment: 'center', textColor: $('cap-color').value,
      strokeColor: base.strokeColor, strokeSize: base.strokeSize, shadowColor: base.shadowColor,
      shadowBlur: base.shadowBlur, shadowOffset: base.shadowOffset,
      glowColor: $('cap-accent').value, highlightColor: $('cap-accent').value,
      frameWidth: info.width, frameHeight: info.height
    };
  }
  function place() {
    var button = $('cap-place');
    busy(button, true, 'Colocando…');
    var info;
    host('$._GotaLegacy.sequenceInfo()').then(function (data) {
      info = data;
      var style = currentStyle(info);
      var highlight = style.style !== 'minimal';
      var ready = [];
      var usable = lines.filter(function (line) { return String(line.text || '').trim() && line.endSeconds > line.startSeconds; });
      var chain = Promise.resolve();
      usable.forEach(function (line, index) {
        chain = chain.then(function () {
          say('cap-status', 'Preparando subtítulos animados: ' + (index + 1) + '/' + usable.length + '…');
          return api('/v1/caption-clip', { units: lineUnits(line, highlight), style: style, fps: info.fps });
        }).then(function (payload) {
          ready.push({ path: payload.movPath, startSeconds: line.startSeconds, endSeconds: line.endSeconds });
        });
      });
      return chain.then(function () { return ready; });
    }).then(function (ready) {
      if (!ready.length) throw new Error('No hay texto para colocar.');
      say('cap-status', 'Colocando ' + ready.length + ' subtítulos en Premiere…');
      return host('$._GotaLegacy.placeCaptionClips(' + JSON.stringify(JSON.stringify({ lines: ready })) + ')');
    }).then(function (result) {
      say('cap-status', 'Listo: ' + result.placed + ' subtítulos animados en la pista V' + result.track + ' (' + info.width + '×' + info.height +
                        '). Los videos están en la carpeta «Gota Subtítulos» del proyecto.');
    }).catch(function (error) { say('cap-status', error.message, true); })
      .then(function () { busy(button, false, 'Colocar en la secuencia'); });
  }
  function styleChanged() {
    var base = STYLES[$('cap-style').value];
    $('cap-size').value = base.fontSize;
    $('cap-accent').value = base.accent;
    $('cap-accent-wrap').style.display = $('cap-style').value === 'minimal' ? 'none' : '';
  }

  // ---------- Silencios ----------
  function waitJob(jobId, label) {
    return api('/v1/jobs/' + jobId).then(function (job) {
      if (job.status === 'queued' || job.status === 'running') {
        say('sil-status', label + ' ' + (job.progress || 0) + '%');
        return delay(400).then(function () { return waitJob(jobId, label); });
      }
      fetch(SERVICE + '/v1/jobs/' + jobId, { method: 'DELETE' }).catch(function () {});
      if (job.status !== 'completed') throw new Error(job.error || 'El análisis de silencios falló.');
      return job.result;
    });
  }
  function removeSilences() {
    var button = $('sil-run');
    var threshold = Number($('sil-threshold').value);
    var minimum = Number($('sil-minimum').value);
    var padding = Number($('sil-padding').value);
    if (!(threshold >= -96 && threshold <= 0)) { say('sil-status', 'Escribe un nivel entre -96 y 0 dB.', true); return; }
    if (!(minimum >= 0.1 && minimum <= 5)) { say('sil-status', 'Escribe una duración entre 0.1 y 5 segundos.', true); return; }
    if (!(padding >= 0 && padding <= 1)) { say('sil-status', 'Escribe un margen entre 0 y 1 segundo.', true); return; }
    busy(button, true, 'Analizando…');
    var pieces = [];
    var removed = 0;
    var notes = [];
    selected().then(function (clips) {
      var chain = Promise.resolve();
      clips.forEach(function (clip, index) {
        if (Math.abs(clip.speed - 1) > 0.01) notes.push('«' + clip.name + '» tiene otra velocidad: en la copia queda a velocidad normal.');
        chain = chain.then(function () {
          return api('/v3/silence-jobs', { mediaPath: clip.mediaPath, thresholdDb: threshold, minimumSilenceSeconds: minimum,
                                           paddingSeconds: padding, startSeconds: clip.inPointSeconds, endSeconds: clip.outPointSeconds });
        }).then(function (created) {
          return waitJob(created.jobId, 'Analizando ' + (index + 1) + '/' + clips.length + ': ' + clip.name + '…');
        }).then(function (result) {
          removed += Number(result.removedDurationSeconds) || 0;
          (result.keptSegments || []).forEach(function (kept) {
            pieces.push({ nodeId: clip.nodeId, inSeconds: kept.startSeconds, outSeconds: kept.endSeconds, audioOnly: clip.mediaKind === 'audio' });
          });
        });
      });
      return chain;
    }).then(function () {
      if (!pieces.length) throw new Error('Todo lo seleccionado parece silencio. Baja el nivel (por ejemplo -50 dB).');
      busy(button, true, 'Armando la copia…');
      say('sil-status', 'Armando una secuencia nueva con ' + pieces.length + ' partes con voz…');
      return host('$._GotaLegacy.buildWithoutSilences(' + JSON.stringify(JSON.stringify({ pieces: pieces })) + ')');
    }).then(function (result) {
      say('sil-status', 'Listo: se creó «' + result.name + '» (' + Math.round(result.seconds) + ' s, se quitaron ' + Math.round(removed) +
                        ' s de silencio). Tu secuencia original quedó igual.' + (notes.length ? '\n' + notes.join('\n') : ''));
    }).catch(function (error) { say('sil-status', error.message, true); })
      .then(function () { busy(button, false, 'Crear copia sin silencios'); });
  }

  $('cap-transcribe').onclick = transcribe;
  $('cap-place').onclick = place;
  $('cap-style').onchange = styleChanged;
  $('sil-run').onclick = removeSilences;
  styleChanged();
}());
