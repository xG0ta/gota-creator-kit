const { entrypoints, shell, storage } = require("uxp");
const ppro = require("premierepro");
const os = require("os");
const localFileSystem = storage.localFileSystem;

const SERVICE_URL = "http://127.0.0.1:8765";
const CURRENT_VERSION = "3.2.86";
const UPDATE_MANIFEST_URL =
  "https://api.github.com/repos/xG0ta/gota-creator-kit/contents/latest.json?ref=main";
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const GOTA_CAPTIONS_MOGRT = "Gota_Subtitulos_Editables.mogrt";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * El supervisor inicia Python justo después de abrir Premiere. En equipos más
 * lentos (o en la primera apertura tras actualizar) las peticiones del panel
 * pueden adelantarse al servidor. Esperar aquí evita mostrar el error técnico
 * "Network request failed" como si hubiera fallado la transcripción.
 */
async function waitForLocalService({ attempts = 50, delayMs = 600 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${SERVICE_URL}/health`);
      if (!response.ok) throw new Error(`Estado ${response.status}`);
      const info = await response.json().catch(() => ({}));
      if (!/^3\./.test(String(info.version || ""))) {
        throw new Error(`Versión incompatible del motor: ${info.version || "desconocida"}`);
      }
      return info;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(delayMs);
    }
  }
  const detail = lastError && lastError.message ? ` (${lastError.message})` : "";
  throw new Error(
    `El motor local no respondió después de ${Math.round((attempts * delayMs) / 1000)} segundos${detail}. ` +
    "Cierra y vuelve a abrir Premiere; si continúa, reinstala la versión más reciente."
  );
}

async function getBundledCaptionsMogrtPath() {
  const pluginFolder = await localFileSystem.getPluginFolder();
  const templatesFolder = await pluginFolder.getEntry("templates");
  const mogrt = await templatesFolder.getEntry(GOTA_CAPTIONS_MOGRT);
  if (!mogrt || !mogrt.nativePath) {
    throw new Error("No se encontro la plantilla de subtítulos incluida en Gota Creator Kit.");
  }
  return mogrt.nativePath;
}

async function makeCaptionMogrt(templatePath, text, style) {
  // Premiere no expone de forma consistente los controles de texto de una
  // MOGRT recién insertada a UXP. El motor crea una copia temporal de la
  // plantilla con el texto ya establecido, por lo que cada gráfico llega con
  // su frase correcta y sigue siendo editable en Propiedades esenciales.
  await waitForLocalService();
  const response = await fetch(`${SERVICE_URL}/v1/caption-mogrt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templatePath, text: String(text || ""), style: style || {} })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.mogrtPath) {
    throw new Error(payload.detail || "No se pudo preparar este gráfico de subtítulo.");
  }
  return payload.mogrtPath;
}

async function applySubtitlePosition(project, trackItem, verticalPercent) {
  const motion = await getMotionComponent(trackItem);
  if (!motion) return false;
  const positionParam = motion.getParam(0);
  const point = new ppro.PointF();
  point.x = 0.5;
  point.y = Math.max(0.05, Math.min(0.95, Number(verticalPercent || 82) / 100));
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(positionParam.createSetTimeVaryingAction(false));
      compoundAction.addAction(positionParam.createSetValueAction(
        positionParam.createKeyframe(point), true
      ));
    }, "Gota Creator Kit: ubicar subtítulo");
  });
  return success;
}

async function applySubtitleEntrance(project, trackItem, style, verticalPercent) {
  // Desde 3.2.33 la animación viaja dentro de la MOGRT original de Gota.
  // No añadimos fotogramas Motion aquí: Premiere puede tratar una MOGRT recién
  // insertada como no animable y eso antes detenía o duplicaba la entrada.
  return false;
}

async function trimMogrtToCaption(project, trackItem, seconds) {
  const duration = Math.max(0.12, Number(seconds) || 0.12);
  try {
    const start = await trackItem.getStartTime();
    const inPoint = await trackItem.getInPoint();
    const outPoint = ppro.TickTime.createWithSeconds(inPoint.seconds + duration);
    let trimmed = false;
    project.lockedAccess(() => {
      trimmed = project.executeTransaction((compoundAction) => {
        compoundAction.addAction(trackItem.createSetOutPointAction(outPoint));
      }, "Gota Creator Kit: ajustar duración de subtítulo");
    });
    if (!trimmed) return false;
    const finalStart = await trackItem.getStartTime();
    // Algunas versiones conservan el final pero desplazan el inicio al
    // recortar una MOGRT. Lo regresamos a su marca exacta si hiciera falta.
    const delta = start.seconds - finalStart.seconds;
    if (Math.abs(delta) > 0.0001) {
      project.lockedAccess(() => {
        project.executeTransaction((compoundAction) => {
          compoundAction.addAction(trackItem.createMoveAction(ppro.TickTime.createWithSeconds(delta)));
        }, "Gota Creator Kit: alinear subtítulo");
      });
    }
    return true;
  } catch (_) {
    return false;
  }
}

function compareVersions(left, right) {
  const parse = (value) => {
    const normalized = String(value || "")
      .trim()
      .replace(/^v/i, "")
      .toLowerCase()
      .replace(/\s+/g, "-");
    const match = normalized.match(
      /^(\d+)\.(\d+)\.(\d+)(?:[-.]?(alpha|beta|rc)[-.]?(\d+)?)?$/
    );
    if (!match) return null;
    const stageRank = { alpha: 0, beta: 1, rc: 2 };
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] || null,
      prereleaseNumber: Number(match[5] || 0),
      stage: match[4] ? stageRank[match[4]] : 3
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] > b.core[index] ? 1 : -1;
    }
  }
  if (a.stage !== b.stage) return a.stage > b.stage ? 1 : -1;
  if (a.prereleaseNumber !== b.prereleaseNumber) {
    return a.prereleaseNumber > b.prereleaseNumber ? 1 : -1;
  }
  return 0;
}

async function getMotionComponent(trackItem) {
  const chain = await trackItem.getComponentChain();
  const count = chain.getComponentCount();
  for (let index = 0; index < count; index += 1) {
    const component = chain.getComponentAtIndex(index);
    const matchName = String(await component.getMatchName()).toLowerCase();
    if (matchName.includes("motion")) return component;
  }
  return null;
}

async function cloneSequence(project, sequence) {
  const existing = new Set(
    (await project.getSequences()).map((item) => item.guid.toString())
  );
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(sequence.createCloneAction());
    }, "AutoFrame: duplicar secuencia original");
  });
  if (!success) throw new Error("Premiere no pudo duplicar la secuencia.");
  const sequences = await project.getSequences();
  const clone = sequences.find((item) => !existing.has(item.guid.toString()));
  if (!clone) throw new Error("No se encontro la secuencia duplicada.");
  return clone;
}

async function makeSequenceVertical(project, sequence) {
  const settings = await sequence.getSettings();
  const rect = new ppro.RectF();
  rect.width = OUTPUT_WIDTH;
  rect.height = OUTPUT_HEIGHT;
  await settings.setVideoFrameRect(rect);
  await settings.setPreviewFrameRect(rect);
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(sequence.createSetSettingsAction(settings));
    }, "AutoFrame: convertir copia a vertical 1080x1920");
  });
  if (!success) throw new Error("No se pudo convertir la copia a 1080x1920.");
}

async function findClonedTrackItem(sequence, clip) {
  if (clip.mediaKind === "audio") return null;
  const track = await sequence.getVideoTrack(clip.trackIndex);
  if (!track) return null;
  const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const start = await item.getStartTime();
    const projectItem = await item.getProjectItem();
    try {
      const media = ppro.ClipProjectItem.cast(projectItem);
      const mediaPath = await media.getMediaFilePath();
      if (mediaPath.toLowerCase() !== clip.mediaPath.toLowerCase()) continue;
      const inPoint = await item.getInPoint();
      const end = await item.getEndTime();
      const sourceScore = Math.abs(inPoint.seconds - clip.inPointSeconds);
      const durationScore = Math.abs(
        (end.seconds - start.seconds) - (clip.timelineDurationSeconds || 0)
      );
      const positionScore = Math.abs(start.seconds - clip.startSeconds);
      const score = sourceScore * 30 + durationScore * 4 + positionScore;
      if (score < bestScore) {
        best = item;
        bestScore = score;
      }
    } catch (_) {
      // Continue looking for the video item.
    }
  }
  return best;
}

async function findMatchingAudioTrackItem(sequence, clip) {
  const trackCount = await sequence.getAudioTrackCount();
  const preferred = Number.isInteger(clip.audioTrackIndex)
    ? [clip.audioTrackIndex]
    : [];
  const trackIndexes = [
    ...preferred,
    ...Array.from({ length: trackCount }, (_, index) => index)
      .filter((index) => !preferred.includes(index))
  ];
  for (const trackIndex of trackIndexes) {
    const track = await sequence.getAudioTrack(trackIndex);
    if (!track) continue;
    const items = track.getTrackItems(
      ppro.Constants.TrackItemType.CLIP, false
    );
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const item of items) {
      const start = await item.getStartTime();
      const inPoint = await item.getInPoint();
      try {
        const projectItem = await item.getProjectItem();
        const media = ppro.ClipProjectItem.cast(projectItem);
        const mediaPath = await media.getMediaFilePath();
        if (mediaPath.toLowerCase() === clip.mediaPath.toLowerCase()) {
          const end = await item.getEndTime();
          const sourceScore = Math.abs(inPoint.seconds - clip.inPointSeconds);
          const durationScore = Math.abs(
            (end.seconds - start.seconds) - (clip.timelineDurationSeconds || 0)
          );
          const positionScore = Math.abs(start.seconds - clip.startSeconds);
          const score = sourceScore * 30 + durationScore * 4 + positionScore;
          if (score < bestScore) {
            best = item;
            bestScore = score;
          }
        }
      } catch (_) {
        // Continue looking for the audio item linked to the selected video.
      }
    }
    if (best) return best;
  }
  return null;
}

function isPremiereReferenceExpired(error) {
  return /script object is no longer valid|object is no longer valid|referencia.*v[aá]lid|objeto.*v[aá]lid/i
    .test(String(error?.message || error || ""));
}

async function recoverSilenceSourcePair(project, sequence, clip, attempts = 10) {
  // En proyectos largos Premiere renueva sus colecciones mientras se añaden
  // los fragmentos. Nunca reutilizamos un TrackItem de una vuelta anterior:
  // recuperamos la pareja fuente justo antes de solicitar el siguiente clon.
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await pauseForPremiere(Math.min(420, 80 * (attempt + 1)));
    try {
      const live = await getLiveSequenceContext(project, sequence);
      const originalAudio = await findMatchingAudioTrackItem(live.sequence, clip);
      const originalVideo = clip.mediaKind === "audio"
        ? null
        : await findClonedTrackItem(live.sequence, clip);
      if (originalAudio && (clip.mediaKind === "audio" || originalVideo)) {
        return { ...live, originalVideo, originalAudio };
      }
    } catch (error) {
      lastError = error;
      if (!isPremiereReferenceExpired(error)) throw error;
    }
  }
  if (lastError) throw lastError;
  throw new Error(`Premiere no pudo recuperar el clip fuente ${clip.name}.`);
}

// El modo que compacta silencios no puede volver a buscar los originales en
// todas las pistas: una vez que Gota crea los nuevos fragmentos, estos usan el
// mismo archivo y pueden parecerse al clip fuente. Buscamos únicamente en la
// pista en la que estaba montado el elemento seleccionado.
async function findOriginalSilenceTrackItem(sequence, clip, mediaKind) {
  const isVideo = mediaKind === "video";
  const trackIndex = isVideo ? clip.trackIndex : clip.audioTrackIndex;
  if (!Number.isInteger(trackIndex)) return null;
  const track = isVideo
    ? await sequence.getVideoTrack(trackIndex)
    : await sequence.getAudioTrack(trackIndex);
  if (!track) return null;
  const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const item of items) {
    try {
      const projectItem = await item.getProjectItem();
      const media = ppro.ClipProjectItem.cast(projectItem);
      const mediaPath = await media.getMediaFilePath();
      if (String(mediaPath).toLowerCase() !== String(clip.mediaPath).toLowerCase()) {
        continue;
      }
      const start = await item.getStartTime();
      const end = await item.getEndTime();
      const inPoint = await item.getInPoint();
      const sourceScore = Math.abs(inPoint.seconds - clip.inPointSeconds);
      const positionScore = Math.abs(start.seconds - clip.startSeconds);
      const durationScore = Math.abs(
        (end.seconds - start.seconds) - (clip.timelineDurationSeconds || 0)
      );
      const score = sourceScore * 30 + positionScore * 10 + durationScore * 4;
      if (score < bestScore) {
        best = item;
        bestScore = score;
      }
    } catch (_) {
      // Premiere puede reconstruir la colección de clips mientras editamos.
    }
  }
  // Si el clip original ya se retiró puede existir otro uso del mismo archivo
  // en esta misma pista. No lo confundimos con la fuente: debe coincidir tanto
  // su punto de origen como su posición inicial.
  return bestScore <= 6 ? best : null;
}

async function findTrackItemAt(track, timelineStart, mediaPath) {
  if (!track) return null;
  const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    try {
      const start = await item.getStartTime();
      if (Math.abs(start.seconds - timelineStart) > 0.05) continue;
      const projectItem = await item.getProjectItem();
      const media = ppro.ClipProjectItem.cast(projectItem);
      const candidatePath = await media.getMediaFilePath();
      if (candidatePath.toLowerCase() === mediaPath.toLowerCase()) return item;
    } catch (_) {
      // Continue looking on the target track.
    }
  }
  return null;
}

// Tras un recorte Premiere puede conservar el nuevo bloque pero asignarle un
// identificador y un inicio ligeramente distintos. En las pistas reservadas
// para Gota buscamos además por el punto de origen, que es estable aunque el
// clip se haya desplazado internamente durante la transacción.
async function findTrackItemBySource(track, mediaPath, sourceStart, expectedStart) {
  if (!track) return null;
  const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const item of items) {
    try {
      const projectItem = await item.getProjectItem();
      const media = ppro.ClipProjectItem.cast(projectItem);
      const candidatePath = await media.getMediaFilePath();
      if (candidatePath.toLowerCase() !== mediaPath.toLowerCase()) continue;
      const inPoint = await item.getInPoint();
      const start = await item.getStartTime();
      const sourceDistance = Math.abs(inPoint.seconds - sourceStart);
      const timelineDistance = Math.abs(start.seconds - expectedStart);
      const score = sourceDistance * 100 + timelineDistance;
      if (score < bestScore) {
        best = item;
        bestScore = score;
      }
    } catch (_) {
      // Premiere puede invalidar una referencia mientras reconstruye la pista.
    }
  }
  return best;
}

function pauseForPremiere(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// En montajes largos Premiere puede tardar varios ciclos de interfaz en volver
// a exponer el TrackItem que acaba de crear. Nunca conservamos una Track ni un
// TrackItem entre esos ciclos: se vuelve a obtener la secuencia viva y se
// busca el bloque por su punto de origen, que permanece estable tras un trim.
async function waitForSilenceTrackItem(
  project, sequence, kind, trackIndex, timelineStart, mediaPath, sourceStart,
  // Los proyectos cortos suelen devolver el TrackItem en el primer intento.
  // En una secuencia larga Premiere puede reconstruir pistas durante varios
  // segundos después de un lote de cortes. Preferimos esperar y recuperar el
  // objeto vivo antes que abortar el trabajo con "object is no longer valid".
  attempts = 18
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await pauseForPremiere(Math.min(360, 45 * (attempt + 1)));
    const live = await getLiveSequenceContext(project, sequence);
    project = live.project;
    sequence = live.sequence;
    const track = kind === "video"
      ? await sequence.getVideoTrack(trackIndex)
      : await sequence.getAudioTrack(trackIndex);
    if (!track) continue;
    const item = await findTrackItemAt(track, timelineStart, mediaPath) ||
      await findTrackItemBySource(track, mediaPath, sourceStart, timelineStart);
    if (item) return { project, sequence, item, attempts: attempt + 1 };
  }
  return null;
}

async function findLowestAvailableTrack(sequence, kind, position) {
  const isVideo = kind === "video";
  const count = isVideo
    ? await sequence.getVideoTrackCount()
    : await sequence.getAudioTrackCount();
  const getTrack = isVideo
    ? (index) => sequence.getVideoTrack(index)
    : (index) => sequence.getAudioTrack(index);
  // Se recorre desde V1/A1 hacia arriba. Una pista está disponible cuando el
  // marcador no cae encima de un clip que ya está en la edición.
  for (let index = 0; index < count; index += 1) {
    const track = await getTrack(index);
    if (!track) continue;
    const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    let occupied = false;
    for (const item of items) {
      const start = await item.getStartTime();
      const end = await item.getEndTime();
      if (position.seconds >= start.seconds - 0.001 && position.seconds < end.seconds - 0.001) {
        occupied = true;
        break;
      }
    }
    if (!occupied) return index;
  }
  // Si todas están ocupadas en este instante, Premiere crea solo una nueva.
  return count;
}

async function findFreeTrackForRange(
  sequence, kind, startSeconds, endSeconds, excludedTrackIndex = -1
) {
  const isVideo = kind === "video";
  const count = isVideo
    ? await sequence.getVideoTrackCount()
    : await sequence.getAudioTrackCount();
  const getTrack = isVideo
    ? (index) => sequence.getVideoTrack(index)
    : (index) => sequence.getAudioTrack(index);
  const safeStart = Number(startSeconds);
  const safeEnd = Math.max(safeStart + 0.001, Number(endSeconds));
  for (let index = 0; index < count; index += 1) {
    // Nunca reutilizamos la pista del original: aunque parezca libre en un
    // instante, Premiere puede partir o desplazar el montaje existente.
    if (index === excludedTrackIndex) continue;
    const track = await getTrack(index);
    if (!track) continue;
    const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    let overlaps = false;
    for (const item of items) {
      const itemStart = await item.getStartTime();
      const itemEnd = await item.getEndTime();
      if (itemStart.seconds < safeEnd - 0.001 && itemEnd.seconds > safeStart + 0.001) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) return index;
  }
  // La API de Premiere crea una pista nueva cuando la clonación apunta al
  // siguiente índice. Así conservamos intactas las pistas con edición.
  return count;
}

async function pickSilenceDestinationTracks(
  sequence, originalVideo, originalAudio, startSeconds, endSeconds
) {
  const audioSourceTrack = await originalAudio.getTrackIndex();
  const audioTrackIndex = await findFreeTrackForRange(
    sequence, "audio", startSeconds, endSeconds, audioSourceTrack
  );
  if (!originalVideo) return { videoTrackIndex: null, audioTrackIndex };
  const videoSourceTrack = await originalVideo.getTrackIndex();
  const videoTrackIndex = await findFreeTrackForRange(
    sequence, "video", startSeconds, endSeconds, videoSourceTrack
  );
  return { videoTrackIndex, audioTrackIndex };
}

// Premiere invalida con frecuencia los objetos obtenidos antes de una
// transacción (sobre todo TrackItem y, en algunas versiones, Sequence). No
// debemos conservarlos entre un clon, un recorte y un movimiento: cada fase
// vuelve a tomar la secuencia viva para que el eliminador no se detenga a
// mitad del montaje con "The script object is no longer valid".
async function getLiveSequenceContext(fallbackProject, fallbackSequence) {
  try {
    const activeProject = await ppro.Project.getActiveProject();
    const activeSequence = activeProject
      ? await activeProject.getActiveSequence()
      : null;
    if (activeProject && activeSequence) {
      return { project: activeProject, sequence: activeSequence };
    }
  } catch (_) {
    // Conservamos el contexto recibido solo como último respaldo.
  }
  return { project: fallbackProject, sequence: fallbackSequence };
}

function buildCutKeyframes(keyframes, sceneCuts) {
  if (!keyframes.length) return [];
  const ordered = [...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const result = [{ ...ordered[0] }];

  for (const cutTime of sceneCuts || []) {
    const next = ordered.find((frame) => frame.timeSeconds >= cutTime);
    if (!next) continue;
    result.push({ ...next, timeSeconds: cutTime });
  }

  let last = result[0];
  for (const frame of ordered) {
    const subjectChanged =
      Math.abs(frame.centerX - last.centerX) > 0.20 ||
      Math.abs(frame.centerY - last.centerY) > 0.16;
    if (subjectChanged && frame.timeSeconds - last.timeSeconds >= 0.75) {
      result.push({ ...frame });
      last = frame;
    }
  }

  return result
    .sort((a, b) => a.timeSeconds - b.timeSeconds)
    .filter((frame, index, all) =>
      index === 0 || Math.abs(frame.timeSeconds - all[index - 1].timeSeconds) > 0.02
    )
    .slice(0, 1200);
}

function calculateMotion(frame, analysisResult) {
  const sourceWidth = analysisResult.sourceWidth;
  const sourceHeight = analysisResult.sourceHeight;
  const conformScale = Math.min(
    OUTPUT_WIDTH / sourceWidth,
    OUTPUT_HEIGHT / sourceHeight
  );
  const conformedWidth = sourceWidth * conformScale;
  const conformedHeight = sourceHeight * conformScale;
  const scaleFactor = Math.max(
    OUTPUT_WIDTH / (frame.width * conformedWidth),
    OUTPUT_HEIGHT / (frame.height * conformedHeight)
  );
  const point = new ppro.PointF();
  point.x = (
    OUTPUT_WIDTH / 2 +
    (0.5 - frame.centerX) * conformedWidth * scaleFactor
  ) / OUTPUT_WIDTH;
  point.y = (
    OUTPUT_HEIGHT / 2 +
    (0.5 - frame.centerY) * conformedHeight * scaleFactor
  ) / OUTPUT_HEIGHT;
  return { point, scalePercent: scaleFactor * 100 };
}

function calculateSlotMotion(frame, analysisResult, slot) {
  const sourceWidth = analysisResult.sourceWidth;
  const sourceHeight = analysisResult.sourceHeight;
  const conformScale = Math.min(
    OUTPUT_WIDTH / sourceWidth,
    OUTPUT_HEIGHT / sourceHeight
  );
  const conformedWidth = sourceWidth * conformScale;
  const conformedHeight = sourceHeight * conformScale;
  const halfHeight = OUTPUT_HEIGHT / 2;
  const separatorHalf = 8;
  const slotHeight = halfHeight - separatorHalf;
  const scaleFactor = Math.max(
    OUTPUT_WIDTH / (frame.width * conformedWidth),
    slotHeight / (frame.height * conformedHeight)
  );
  const point = new ppro.PointF();
  point.x = (
    OUTPUT_WIDTH / 2 +
    (0.5 - frame.centerX) * conformedWidth * scaleFactor
  ) / OUTPUT_WIDTH;
  const slotCenter = slot === "top"
    ? slotHeight / 2
    : halfHeight + separatorHalf + slotHeight / 2;
  point.y = (
    slotCenter +
    (0.5 - frame.centerY) * conformedHeight * scaleFactor
  ) / OUTPUT_HEIGHT;
  const renderedHeight = conformedHeight * scaleFactor;
  const cropBoundaryY = Math.max(0, Math.min(1,
    0.5 +
    (OUTPUT_HEIGHT / 2 - point.y * OUTPUT_HEIGHT) / renderedHeight
  ));
  return {
    point,
    scalePercent: scaleFactor * 100,
    cropBoundaryY
  };
}

async function applyCrop(project, item, slot, cropBoundaryY) {
  const matchNames = await ppro.VideoFilterFactory.getMatchNames();
  const displayNames = await ppro.VideoFilterFactory.getDisplayNames();
  let cropMatch = "";
  for (let index = 0; index < matchNames.length; index += 1) {
    const label = String(displayNames[index] || "").toLowerCase();
    const match = String(matchNames[index] || "").toLowerCase();
    if (label === "crop" || label === "recortar" || match.includes("crop")) {
      cropMatch = matchNames[index];
      break;
    }
  }
  if (!cropMatch) throw new Error("No se encontro el efecto Recortar de Premiere.");
  const crop = await ppro.VideoFilterFactory.createComponent(cropMatch);
  const chain = await item.getComponentChain();
  let appended = false;
  project.lockedAccess(() => {
    appended = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(chain.createAppendComponentAction(crop));
    }, "AutoFrame: agregar recorte para plano doble");
  });
  if (!appended) throw new Error("No se pudo agregar el recorte del plano doble.");

  const updatedChain = await item.getComponentChain();
  let insertedCrop = null;
  for (let index = updatedChain.getComponentCount() - 1; index >= 0; index -= 1) {
    const component = updatedChain.getComponentAtIndex(index);
    const componentMatch = String(await component.getMatchName()).toLowerCase();
    if (componentMatch === String(cropMatch).toLowerCase()) {
      insertedCrop = component;
      break;
    }
  }
  if (!insertedCrop) {
    throw new Error("Premiere agrego Recortar, pero no devolvio sus controles.");
  }

  const normalizeName = (value) => String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const params = {};
  for (let index = 0; index < insertedCrop.getParamCount(); index += 1) {
    const param = insertedCrop.getParam(index);
    const name = normalizeName(param.displayName);
    if (name.includes("left") || name.includes("izquierda")) params.left = param;
    if (name.includes("top") || name.includes("arriba")) params.top = param;
    if (name.includes("right") || name.includes("derecha")) params.right = param;
    if (name.includes("bottom") || name.includes("abajo")) params.bottom = param;
  }
  if (!params.top || !params.bottom) {
    throw new Error(
      "Premiere no devolvio los controles Arriba/Abajo del efecto Recortar."
    );
  }
  project.lockedAccess(() => {
    appended = project.executeTransaction((compoundAction) => {
      const boundaryPercent = cropBoundaryY * 100;
      const cropTop = slot === "bottom" ? boundaryPercent : 0;
      const cropBottom = slot === "top" ? 100 - boundaryPercent : 0;
      compoundAction.addAction(params.top.createSetValueAction(
        params.top.createKeyframe(cropTop), true
      ));
      compoundAction.addAction(params.bottom.createSetValueAction(
        params.bottom.createKeyframe(cropBottom), true
      ));
      if (params.left) {
        compoundAction.addAction(params.left.createSetValueAction(
          params.left.createKeyframe(0), true
        ));
      }
      if (params.right) {
        compoundAction.addAction(params.right.createSetValueAction(
          params.right.createKeyframe(0), true
        ));
      }
    }, "AutoFrame: limitar area del rostro");
  });
  if (!appended) throw new Error("No se pudieron ajustar los bordes del recorte.");
}

async function applyStaticMotion(project, item, frame, analysisResult, slot = null) {
  const motion = await getMotionComponent(item);
  if (!motion) throw new Error("No se encontro Motion en un segmento.");
  const positionParam = motion.getParam(0);
  const scaleParam = motion.getParam(1);
  const values = slot
    ? calculateSlotMotion(frame, analysisResult, slot)
    : calculateMotion(frame, analysisResult);
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(positionParam.createSetTimeVaryingAction(false));
      compoundAction.addAction(scaleParam.createSetTimeVaryingAction(false));
    }, "AutoFrame: desactivar animacion del segmento");
  });
  if (!success) throw new Error("No se pudo desactivar la animacion del segmento.");
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(positionParam.createSetValueAction(
        positionParam.createKeyframe(values.point), true
      ));
      compoundAction.addAction(scaleParam.createSetValueAction(
        scaleParam.createKeyframe(values.scalePercent), true
      ));
    }, "AutoFrame: encuadre fijo del segmento");
  });
  if (!success) throw new Error("Premiere rechazo el encuadre fijo.");
  if (slot) {
    await applyCrop(project, item, slot, values.cropBoundaryY);
  }
}

function createEmptyTrackSelectionNow() {
  let selection = null;
  ppro.TrackItemSelection.createEmptySelection((created) => {
    selection = created;
  });
  if (!selection) throw new Error("No se pudo crear la seleccion para los cortes.");
  return selection;
}

async function createEmptyTrackSelection() {
  return createEmptyTrackSelectionNow();
}

async function applyCutsOnly(project, clone, analyses) {
  for (const analysis of analyses) {
    const originalItem = await findClonedTrackItem(clone, analysis.clip);
    if (!originalItem) {
      throw new Error(`No se encontro ${analysis.clip.name} en la copia.`);
    }
    const selection = await createEmptyTrackSelection();
    selection.addItem(originalItem, false);
    const cutOk = await ppro.SequenceUtils.performSceneEditDetectionOnSelection(
      ppro.Constants.SequenceOperation.APPLYCUT,
      selection
    );
    if (!cutOk) throw new Error("Premiere no pudo crear los cortes de escena.");

    const track = await clone.getVideoTrack(analysis.clip.trackIndex);
    const pieces = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (const piece of pieces) {
      const start = await piece.getStartTime();
      const end = await piece.getEndTime();
      const clipEnd = analysis.clip.startSeconds + analysis.clip.durationSeconds;
      if (end.seconds <= analysis.clip.startSeconds || start.seconds >= clipEnd) continue;
      const projectItem = await piece.getProjectItem();
      let path = "";
      try {
        path = await ppro.ClipProjectItem.cast(projectItem).getMediaFilePath();
      } catch (_) {
        continue;
      }
      if (path.toLowerCase() !== analysis.clip.mediaPath.toLowerCase()) continue;
      const inPoint = await piece.getInPoint();
      const outPoint = await piece.getOutPoint();
      let candidates = analysis.result.keyframes.filter(
        (candidate) =>
          candidate.timeSeconds >= inPoint.seconds &&
          candidate.timeSeconds <= outPoint.seconds
      );
      const sourceMiddle = (inPoint.seconds + outPoint.seconds) / 2;
      const editorialShot = (analysis.result.shots || []).find(
        (shot) =>
          sourceMiddle >= shot.startSeconds &&
          sourceMiddle <= shot.endSeconds
      );
      if (editorialShot && editorialShot.mode === "original") {
        continue;
      }
      if (
        analysis.result.profile !== "camera_shots" &&
        editorialShot &&
        editorialShot.subjectId
      ) {
        const speakerCandidates = candidates.filter(
          (candidate) => candidate.subjectId === editorialShot.subjectId
        );
        if (speakerCandidates.length) candidates = speakerCandidates;
      }
      const frame = chooseRepresentativeFrame(candidates) ||
        analysis.result.keyframes.find(
          (candidate) => candidate.timeSeconds >= inPoint.seconds
        ) ||
        analysis.result.keyframes[analysis.result.keyframes.length - 1];
      const layout = chooseRepresentativeLayout(
        analysis.result.layoutFrames.filter(
          (candidate) =>
            candidate.timeSeconds >= inPoint.seconds &&
            candidate.timeSeconds <= outPoint.seconds
        )
      );
      const wantsSplit = analysis.result.profile === "camera_shots"
        ? layout && layout.mode === "split"
        : editorialShot
        ? editorialShot.mode === "split"
        : layout && layout.mode === "split";
      if (layout && wantsSplit) {
        const duplicate = await clonePieceToTrackAbove(
          project, clone, piece, analysis.clip.trackIndex
        );
        await applyStaticMotion(
          project, piece, layout.subjects[0], analysis.result, "top"
        );
        await applyStaticMotion(
          project, duplicate, layout.subjects[1], analysis.result, "bottom"
        );
      } else if (frame) {
        await applyStaticMotion(project, piece, frame, analysis.result);
      }
    }
  }
}

async function clonePieceToTrackAbove(project, sequence, piece, trackIndex) {
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const zero = ppro.TickTime.createWithSeconds(0);
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(editor.createCloneTrackItemAction(
        piece, zero, 1, 0, true, false
      ));
    }, "AutoFrame: duplicar rostro para plano doble");
  });
  if (!success) throw new Error("No se pudo crear la segunda capa del plano doble.");
  const start = await piece.getStartTime();
  const track = await sequence.getVideoTrack(trackIndex + 1);
  const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  let duplicate = null;
  for (const item of items) {
    const itemStart = await item.getStartTime();
    if (Math.abs(itemStart.seconds - start.seconds) < 0.03) {
      duplicate = item;
      break;
    }
  }
  if (!duplicate) throw new Error("No se encontro la segunda capa creada.");
  return duplicate;
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  if (!ordered.length) return 0;
  return ordered[Math.floor(ordered.length / 2)];
}

function chooseRepresentativeFrame(frames) {
  if (!frames.length) return null;
  const middleX = median(frames.map((frame) => frame.centerX));
  const left = frames.filter((frame) => frame.centerX <= middleX);
  const right = frames.filter((frame) => frame.centerX > middleX);
  const activity = (group) => group.reduce(
    (sum, frame) => sum + Number(frame.mouthActivity || 0), 0
  );
  let selected = frames;
  if (left.length >= 2 && right.length >= 2) {
    const leftScore = activity(left);
    const rightScore = activity(right);
    if (Math.max(leftScore, rightScore) > 0.025) {
      selected = leftScore >= rightScore ? left : right;
    } else {
      selected = left.length >= right.length ? left : right;
    }
  }
  const centerX = median(selected.map((frame) => frame.centerX));
  const centerY = median(selected.map((frame) => frame.centerY));
  const width = median(selected.map((frame) => frame.width));
  const height = median(selected.map((frame) => frame.height));
  return {
    ...selected[Math.floor(selected.length / 2)],
    centerX,
    centerY,
    width,
    height
  };
}

function chooseRepresentativeLayout(frames) {
  if (!frames.length) return null;
  const split = frames.filter(
    (frame) => frame.mode === "split" && frame.subjects.length === 2
  );
  const confirmedSpan = split.length > 1
    ? split[split.length - 1].timeSeconds - split[0].timeSeconds
    : 0;
  if (
    split.length < 3 ||
    split.length / frames.length < 0.65 ||
    confirmedSpan < 0.8
  ) return null;
  return {
    mode: "split",
    subjects: [0, 1].map((index) => ({
      centerX: median(split.map((frame) => frame.subjects[index].centerX)),
      centerY: median(split.map((frame) => frame.subjects[index].centerY)),
      width: median(split.map((frame) => frame.subjects[index].width)),
      height: median(split.map((frame) => frame.subjects[index].height))
    }))
  };
}

function multicamLocalTime(analysis, mediaTime) {
  const info = analysis.clip.multicam;
  const nestedTime = info.nestedItemStartSeconds +
    (mediaTime - info.nestedItemInPointSeconds) /
      Math.max(0.001, info.nestedItemSpeedFactor);
  return (nestedTime - info.parentInPointSeconds) /
    Math.max(0.001, info.parentSpeedFactor);
}

function nearestMulticamFrame(analysis, localTime) {
  let nearest = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const frame of analysis.result.keyframes || []) {
    const candidateTime = multicamLocalTime(analysis, frame.timeSeconds);
    const candidateDistance = Math.abs(candidateTime - localTime);
    if (candidateDistance < distance) {
      nearest = frame;
      distance = candidateDistance;
    }
  }
  return distance <= 1.25 ? nearest : null;
}

function multicamFrameScore(frame) {
  if (!frame) return -1000;
  const confidence = Number(frame.confidence || 0);
  const mouth = Number(frame.mouthActivity || 0);
  const faceArea = Number(frame.width || 0) * Number(frame.height || 0);
  return confidence + Math.min(1.5, mouth * 12) + Math.min(0.8, faceArea * 5);
}

function buildMulticamPlan(analyses, minimumShotSeconds) {
  if (!analyses.length) return [];
  const parent = analyses[0].clip.multicam;
  const duration = Math.max(
    0.01, (parent.parentEndSeconds - parent.parentStartSeconds)
  );
  const sampleTimes = new Set([0, duration]);
  for (const analysis of analyses) {
    for (const frame of analysis.result.keyframes || []) {
      const local = multicamLocalTime(analysis, frame.timeSeconds);
      if (local >= 0 && local <= duration) {
        sampleTimes.add(Math.round(local * 20) / 20);
      }
    }
  }
  const ordered = [...sampleTimes].sort((a, b) => a - b);
  const decisions = [];
  for (const time of ordered) {
    let winner = null;
    let winnerFrame = null;
    let winnerScore = -1000;
    for (const analysis of analyses) {
      const frame = nearestMulticamFrame(analysis, time);
      const score = multicamFrameScore(frame);
      if (score > winnerScore) {
        winner = analysis;
        winnerFrame = frame;
        winnerScore = score;
      }
    }
    if (winner) decisions.push({ time, analysis: winner, frame: winnerFrame });
  }
  if (!decisions.length) return [];
  const minimum = Math.max(0.4, Number(minimumShotSeconds) || 1.8);
  const segments = [];
  let current = {
    start: 0,
    analysis: decisions[0].analysis,
    frame: decisions[0].frame
  };
  for (const decision of decisions.slice(1)) {
    if (
      decision.analysis !== current.analysis &&
      decision.time - current.start >= minimum
    ) {
      segments.push({ ...current, end: decision.time });
      current = {
        start: decision.time,
        analysis: decision.analysis,
        frame: decision.frame
      };
    } else if (decision.analysis === current.analysis && decision.frame) {
      current.frame = decision.frame;
    }
  }
  segments.push({ ...current, end: duration });
  return segments.filter((segment) => segment.end - segment.start > 0.02);
}

async function findMulticamParentItem(sequence, analysis) {
  const info = analysis.clip.multicam;
  const track = await sequence.getVideoTrack(info.parentTrackIndex);
  if (!track) return null;
  const expectedId = await info.parentProjectItem.getId();
  const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  for (const item of items) {
    const start = await item.getStartTime();
    if (Math.abs(start.seconds - info.parentStartSeconds) > 0.05) continue;
    const projectItem = await item.getProjectItem();
    if (await projectItem.getId() === expectedId) return item;
  }
  return null;
}

async function cloneMulticamAngleSegment(
  project, sequence, segment, destinationTrackIndex
) {
  const analysis = segment.analysis;
  const info = analysis.clip.multicam;
  const sourceItem = info.nestedItem;
  const sourceTrackIndex = await sourceItem.getTrackIndex();
  const targetStart = info.parentStartSeconds + segment.start;
  const sourceStart = info.nestedItemInPointSeconds +
    (
      info.parentInPointSeconds +
      segment.start * info.parentSpeedFactor -
      info.nestedItemStartSeconds
    ) * info.nestedItemSpeedFactor;
  const sourceEnd = info.nestedItemInPointSeconds +
    (
      info.parentInPointSeconds +
      segment.end * info.parentSpeedFactor -
      info.nestedItemStartSeconds
    ) * info.nestedItemSpeedFactor;
  const sourceTimelineStart = await sourceItem.getStartTime();
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const offset = ppro.TickTime.createWithSeconds(
    targetStart - sourceTimelineStart.seconds
  );
  let cloned = false;
  project.lockedAccess(() => {
    cloned = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(editor.createCloneTrackItemAction(
        sourceItem,
        offset,
        destinationTrackIndex - sourceTrackIndex,
        0,
        true,
        false
      ));
    }, "Gota Kit: crear cambio de camara");
  });
  if (!cloned) {
    throw new Error("Premiere no pudo copiar uno de los angulos multicamara.");
  }
  const targetTrack = await sequence.getVideoTrack(destinationTrackIndex);
  const duplicate = await findTrackItemAt(
    targetTrack, targetStart, analysis.clip.mediaPath
  );
  if (!duplicate) {
    throw new Error("Premiere creo el angulo, pero no pudo localizarlo.");
  }
  let trimmed = false;
  project.lockedAccess(() => {
    trimmed = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(duplicate.createSetInPointAction(
        ppro.TickTime.createWithSeconds(sourceStart)
      ));
      compoundAction.addAction(duplicate.createSetOutPointAction(
        ppro.TickTime.createWithSeconds(sourceEnd)
      ));
    }, "Gota Kit: recortar cambio de camara");
  });
  if (!trimmed) throw new Error("Premiere no pudo recortar un cambio de camara.");
  const trimmedStart = await duplicate.getStartTime();
  const movement = targetStart - trimmedStart.seconds;
  if (Math.abs(movement) > 0.000001) {
    let moved = false;
    project.lockedAccess(() => {
      moved = project.executeTransaction((compoundAction) => {
        compoundAction.addAction(duplicate.createMoveAction(
          ppro.TickTime.createWithSeconds(movement)
        ));
      }, "Gota Kit: colocar cambio de camara");
    });
    if (!moved) throw new Error("Premiere no pudo colocar un cambio de camara.");
  }
  return duplicate;
}

async function applyMulticamReframe(
  project, sequence, analyses, minimumShotSeconds
) {
  const clone = await cloneSequence(project, sequence);
  await makeSequenceVertical(project, clone);
  const groups = new Map();
  for (const analysis of analyses) {
    const id = analysis.clip.multicam.parentId;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(analysis);
  }
  for (const group of groups.values()) {
    const parentItem = await findMulticamParentItem(clone, group[0]);
    if (!parentItem) {
      throw new Error("No se encontro la multicamara en la copia.");
    }
    const plan = buildMulticamPlan(group, minimumShotSeconds);
    if (!plan.length) {
      throw new Error("No se encontraron rostros utilizables en las camaras.");
    }
    const destinationTrackIndex =
      group[0].clip.multicam.parentTrackIndex + 1;
    for (const segment of plan) {
      const piece = await cloneMulticamAngleSegment(
        project, clone, segment, destinationTrackIndex
      );
      const representative = segment.frame ||
        nearestMulticamFrame(
          segment.analysis, (segment.start + segment.end) / 2
        );
      if (representative) {
        await applyStaticMotion(
          project, piece, representative, segment.analysis.result
        );
      }
    }
    if (typeof parentItem.createSetDisabledAction === "function") {
      let disabled = false;
      project.lockedAccess(() => {
        disabled = project.executeTransaction((compoundAction) => {
          compoundAction.addAction(parentItem.createSetDisabledAction(true));
        }, "Gota Kit: ocultar multicamara original");
      });
      if (!disabled) {
        throw new Error("No se pudo ocultar el video multicamara original.");
      }
    }
  }
  const opened = await project.openSequence(clone);
  if (!opened) throw new Error("La copia multicamara se creo, pero no se abrio.");
  await project.setActiveSequence(clone);
  return clone;
}

async function applyReframe(project, sequence, analyses, editStyle) {
  const clone = await cloneSequence(project, sequence);
  await makeSequenceVertical(project, clone);

  if (editStyle === "cuts") {
    await applyCutsOnly(project, clone, analyses);
  } else {
  for (const analysis of analyses) {
    const item = await findClonedTrackItem(clone, analysis.clip);
    if (!item) throw new Error(`No se encontro ${analysis.clip.name} en la copia.`);
    const motion = await getMotionComponent(item);
    if (!motion) throw new Error(`No se encontro Motion en ${analysis.clip.name}.`);
    const positionParam = motion.getParam(0);
    const scaleParam = motion.getParam(1);

    project.lockedAccess(() => {
      project.executeTransaction((compoundAction) => {
        compoundAction.addAction(positionParam.createSetTimeVaryingAction(true));
        compoundAction.addAction(scaleParam.createSetTimeVaryingAction(true));
      }, "AutoFrame: activar keyframes de Motion");
    });

    const frames = buildCutKeyframes(
      analysis.result.keyframes,
      analysis.result.sceneCuts
    ).filter((frame) => {
      const localTime = frame.timeSeconds - analysis.clip.inPointSeconds;
      return localTime >= 0 && localTime <= analysis.clip.durationSeconds;
    });
    if (!frames.length) throw new Error(`No hay encuadres aplicables para ${analysis.clip.name}.`);

    let success = false;
    project.lockedAccess(() => {
      success = project.executeTransaction((compoundAction) => {
        for (const frame of frames) {
          const localTime = frame.timeSeconds - analysis.clip.inPointSeconds;
          const values = calculateMotion(frame, analysis.result);

          const positionKey = positionParam.createKeyframe(values.point);
          const keyTime = ppro.TickTime.createWithSeconds(localTime);
          positionKey.position = keyTime;
          compoundAction.addAction(positionParam.createAddKeyframeAction(positionKey));
          compoundAction.addAction(
            positionParam.createSetInterpolationAtKeyframeAction(
              keyTime, ppro.Constants.InterpolationMode.HOLD, false
            )
          );

          const scaleKey = scaleParam.createKeyframe(values.scalePercent);
          scaleKey.position = keyTime;
          compoundAction.addAction(scaleParam.createAddKeyframeAction(scaleKey));
          compoundAction.addAction(
            scaleParam.createSetInterpolationAtKeyframeAction(
              keyTime, ppro.Constants.InterpolationMode.HOLD, false
            )
          );
        }
      }, "AutoFrame: aplicar seguimiento facial");
    });
    if (!success) throw new Error(`Premiere rechazo los keyframes de ${analysis.clip.name}.`);
  }
  }

  const opened = await project.openSequence(clone);
  if (!opened) throw new Error("La copia se creo, pero Premiere no pudo abrirla.");
  const activated = await project.setActiveSequence(clone);
  if (!activated) throw new Error("La copia se abrio, pero no pudo quedar activa.");
  return clone;
}

async function collectSelectedVideoClips(sequence) {
  const selection = await sequence.getSelection();
  const items = await selection.getTrackItems();
  const clips = [];
  const seenItems = new Set();
  for (const item of items) {
    if (typeof item.getComponentChain !== "function") continue;
    try {
      if (
        typeof item.getMediaType === "function" &&
        String(await item.getMediaType()) ===
          String(ppro.Constants.MediaType.AUDIO)
      ) continue;
    } catch (_) {
      // Las versiones tempranas de UXP no siempre exponen el tipo.
    }
    const projectItem = await item.getProjectItem();
    let clip;
    try {
      clip = ppro.ClipProjectItem.cast(projectItem);
    } catch (_) {
      continue;
    }
    let isMulticam = false;
    try {
      isMulticam = await clip.isMulticamClip();
    } catch (_) {
      // Older Premiere builds can omit this query.
    }
    const trackIndex = await item.getTrackIndex();
    const startTime = await item.getStartTime();
    const endTime = await item.getEndTime();
    const inPoint = await item.getInPoint();
    const outPoint = await item.getOutPoint();
    const rawSpeed = Math.abs(Number(await item.getSpeed()) || 1);
    const speedFactor = rawSpeed > 10 ? rawSpeed / 100 : rawSpeed;
    const timelineDurationSeconds = Math.max(
      0.001, endTime.seconds - startTime.seconds
    );
    const mountedSourceEnd = inPoint.seconds +
      timelineDurationSeconds * speedFactor;
    const effectiveOutPointSeconds = Math.min(
      outPoint.seconds, mountedSourceEnd
    );
    const sourceDurationSeconds = Math.max(
      0.001, effectiveOutPointSeconds - inPoint.seconds
    );
    if (isMulticam) {
      let nestedSequence = null;
      try {
        nestedSequence = await clip.getSequence();
      } catch (_) {
        // A malformed multicam item can have no accessible backing sequence.
      }
      if (!nestedSequence) continue;
      const parentId = [
        "multicam", trackIndex, startTime.seconds, inPoint.seconds,
        effectiveOutPointSeconds
      ].join("|");
      const angleCount = await nestedSequence.getVideoTrackCount();
      for (let angleIndex = 0; angleIndex < angleCount; angleIndex += 1) {
        const angleTrack = await nestedSequence.getVideoTrack(angleIndex);
        if (!angleTrack || await angleTrack.isMuted()) continue;
        const angleItems = angleTrack.getTrackItems(
          ppro.Constants.TrackItemType.CLIP, false
        );
        for (const angleItem of angleItems) {
          const angleStart = await angleItem.getStartTime();
          const angleEnd = await angleItem.getEndTime();
          const nestedStart = Math.max(inPoint.seconds, angleStart.seconds);
          const nestedEnd = Math.min(effectiveOutPointSeconds, angleEnd.seconds);
          if (nestedEnd - nestedStart < 0.01) continue;
          let angleClip;
          try {
            angleClip = ppro.ClipProjectItem.cast(
              await angleItem.getProjectItem()
            );
          } catch (_) {
            continue;
          }
          const mediaPath = await angleClip.getMediaFilePath();
          if (!mediaPath) continue;
          const angleIn = await angleItem.getInPoint();
          const angleSpeedRaw = Math.abs(
            Number(await angleItem.getSpeed()) || 1
          );
          const angleSpeed = angleSpeedRaw > 10
            ? angleSpeedRaw / 100
            : angleSpeedRaw;
          const mediaStart = angleIn.seconds +
            (nestedStart - angleStart.seconds) * angleSpeed;
          const mediaEnd = angleIn.seconds +
            (nestedEnd - angleStart.seconds) * angleSpeed;
          clips.push({
            name: `Camara ${angleIndex + 1}: ${await angleItem.getName()}`,
            mediaPath,
            trackIndex,
            startSeconds: startTime.seconds,
            endSeconds: endTime.seconds,
            inPointSeconds: mediaStart,
            outPointSeconds: mediaEnd,
            durationSeconds: mediaEnd - mediaStart,
            sourceDurationSeconds: mediaEnd - mediaStart,
            timelineDurationSeconds:
              (nestedEnd - nestedStart) / speedFactor,
            sourceToTimelineScale: 1 / (angleSpeed * speedFactor),
            multicam: {
              parentId,
              parentProjectItem: clip,
              parentTrackIndex: trackIndex,
              parentStartSeconds: startTime.seconds,
              parentEndSeconds: endTime.seconds,
              parentInPointSeconds: inPoint.seconds,
              parentSpeedFactor: speedFactor,
              nestedTrackIndex: angleIndex,
              nestedItem: angleItem,
              nestedItemStartSeconds: angleStart.seconds,
              nestedItemEndSeconds: angleEnd.seconds,
              nestedOverlapStartSeconds: nestedStart,
              nestedOverlapEndSeconds: nestedEnd,
              nestedItemInPointSeconds: angleIn.seconds,
              nestedItemSpeedFactor: angleSpeed
            }
          });
        }
      }
      continue;
    }
    const mediaPath = await clip.getMediaFilePath();
    if (!mediaPath) continue;
    const itemKey = [
      mediaPath.toLowerCase(), trackIndex, startTime.seconds,
      inPoint.seconds, effectiveOutPointSeconds
    ].join("|");
    if (seenItems.has(itemKey)) continue;
    seenItems.add(itemKey);
    const clipInfo = {
      name: await item.getName(),
      mediaPath,
      trackIndex,
      startSeconds: startTime.seconds,
      endSeconds: endTime.seconds,
      inPointSeconds: inPoint.seconds,
      outPointSeconds: effectiveOutPointSeconds,
      speedFactor,
      durationSeconds: sourceDurationSeconds,
      sourceDurationSeconds,
      timelineDurationSeconds,
      sourceToTimelineScale:
        timelineDurationSeconds / sourceDurationSeconds
    };
    const matchingAudio = await findMatchingAudioTrackItem(
      sequence, clipInfo
    );
    if (matchingAudio) {
      clipInfo.audioTrackIndex = await matchingAudio.getTrackIndex();
    }
    clips.push(clipInfo);
  }
  return clips;
}

async function collectSelectedSilenceClips(sequence) {
  const videoClips = await collectSelectedVideoClips(sequence);
  const selection = await sequence.getSelection();
  const items = await selection.getTrackItems();
  const clips = [...videoClips];
  const knownAudio = new Set(videoClips.map((clip) => [
    String(clip.mediaPath).toLowerCase(),
    Math.round(clip.startSeconds * 100),
    Math.round(clip.inPointSeconds * 100)
  ].join("|")));
  for (const item of items) {
    try {
      if (
        typeof item.getMediaType !== "function" ||
        String(await item.getMediaType()) !==
          String(ppro.Constants.MediaType.AUDIO)
      ) continue;
      const projectItem = await item.getProjectItem();
      const media = ppro.ClipProjectItem.cast(projectItem);
      const mediaPath = await media.getMediaFilePath();
      if (!mediaPath) continue;
      const start = await item.getStartTime();
      const end = await item.getEndTime();
      const inPoint = await item.getInPoint();
      const outPoint = await item.getOutPoint();
      const rawSpeed = Math.abs(Number(await item.getSpeed()) || 1);
      const speedFactor = rawSpeed > 10 ? rawSpeed / 100 : rawSpeed;
      const timelineDurationSeconds = Math.max(0.001, end.seconds - start.seconds);
      const mountedEnd = Math.min(
        outPoint.seconds, inPoint.seconds + timelineDurationSeconds * speedFactor
      );
      const key = [
        mediaPath.toLowerCase(), Math.round(start.seconds * 100),
        Math.round(inPoint.seconds * 100)
      ].join("|");
      if (knownAudio.has(key)) continue;
      knownAudio.add(key);
      clips.push({
        mediaKind: "audio",
        name: await item.getName(),
        mediaPath,
        audioTrackIndex: await item.getTrackIndex(),
        startSeconds: start.seconds,
        endSeconds: end.seconds,
        inPointSeconds: inPoint.seconds,
        outPointSeconds: mountedEnd,
        durationSeconds: mountedEnd - inPoint.seconds,
        sourceDurationSeconds: mountedEnd - inPoint.seconds,
        timelineDurationSeconds,
        sourceToTimelineScale: timelineDurationSeconds /
          Math.max(0.001, mountedEnd - inPoint.seconds)
      });
    } catch (_) {
      // El elemento seleccionado no es un clip de audio utilizable.
    }
  }
  return clips;
}

async function refreshAnalysisLocations(sequence, analyses) {
  const selected = await collectSelectedSilenceClips(sequence);
  let refreshed = 0;
  for (const analysis of analyses) {
    const previous = analysis.clip;
    const candidates = selected.filter((candidate) =>
      candidate.mediaKind === previous.mediaKind &&
      String(candidate.mediaPath).toLowerCase() ===
        String(previous.mediaPath).toLowerCase() &&
      Math.abs(candidate.inPointSeconds - previous.inPointSeconds) < 0.12
    );
    const candidate = candidates.sort((left, right) =>
      Math.abs(left.startSeconds - previous.startSeconds) -
      Math.abs(right.startSeconds - previous.startSeconds)
    )[0];
    if (!candidate) continue;
    analysis.clip = { ...previous, ...candidate };
    refreshed += 1;
  }
  return refreshed;
}

async function cloneTrimmedSegmentOnce(
  project, sequence, originalVideo, originalAudio, sourceStart, sourceEnd,
  timelineStart, targetVideoTrackIndex, targetAudioTrackIndex, name
) {
  let live = await getLiveSequenceContext(project, sequence);
  project = live.project;
  sequence = live.sequence;
  const editor = ppro.SequenceEditor.getEditor(sequence);
  if (!editor) {
    throw new Error("Premiere no pudo abrir el editor de la secuencia activa.");
  }
  if (!originalAudio) {
    throw new Error(
      "No se encontró el audio correspondiente al video seleccionado."
    );
  }
  const originalVideoTrackIndex = await originalVideo.getTrackIndex();
  const originalAudioTrackIndex = await originalAudio.getTrackIndex();
  const originalVideoStart = await originalVideo.getStartTime();
  const originalAudioStart = await originalAudio.getStartTime();
  const originalAudioInPoint = await originalAudio.getInPoint();
  // Premiere invalida las referencias de origen cuando crea el primer bloque
  // en una pista. Todo dato del original que usaremos después debe leerse
  // antes de la clonación; consultar getSpeed() después era la causa de
  // "The script object is no longer valid" y dejaba el original sin retirar.
  const rawSpeed = Math.abs(Number(await originalVideo.getSpeed()) || 1);
  const speedFactor = rawSpeed > 10 ? rawSpeed / 100 : rawSpeed;
  // Se obtiene antes de clonar: el TrackItem original puede quedar inválido
  // en cuanto Premiere crea el nuevo bloque.
  const mediaProjectItem = await originalVideo.getProjectItem();
  const media = ppro.ClipProjectItem.cast(mediaProjectItem);
  const mediaPath = await media.getMediaFilePath();
  // Si Premiere perdió una referencia justo después de crear el bloque, no
  // volvemos a duplicarlo. Primero recuperamos ese mismo bloque por su pista,
  // instante y punto de origen y continuamos el recorte desde ahí. En clips
  // largos esto evita duplicados y permite retomar el trabajo tras una
  // reconstrucción interna de la secuencia.
  const existingVideo = await waitForSilenceTrackItem(
    project, sequence, "video", targetVideoTrackIndex,
    timelineStart, mediaPath, sourceStart, 1
  );
  const existingAudio = await waitForSilenceTrackItem(
    existingVideo ? existingVideo.project : project,
    existingVideo ? existingVideo.sequence : sequence,
    "audio", targetAudioTrackIndex,
    timelineStart, mediaPath, sourceStart, 1
  );
  const videoOffset = ppro.TickTime.createWithSeconds(
    timelineStart - originalVideoStart.seconds
  );
  const audioOffset = ppro.TickTime.createWithSeconds(
    timelineStart - originalAudioStart.seconds
  );
  let duplicateVideo = existingVideo ? existingVideo.item : null;
  let duplicateAudio = existingAudio ? existingAudio.item : null;
  if (existingVideo) {
    project = existingVideo.project;
    sequence = existingVideo.sequence;
  }
  if (existingAudio) {
    project = existingAudio.project;
    sequence = existingAudio.sequence;
  }
  if (!duplicateVideo || !duplicateAudio) {
    let cloned = false;
    project.lockedAccess(() => {
      cloned = project.executeTransaction((compoundAction) => {
        // Al clonar desde el video, Premiere conserva el vínculo con el audio
        // cuando ambos elementos provienen del mismo clip. Hacer dos clones
        // independientes era la causa de que se separaran al moverlos.
        compoundAction.addAction(editor.createCloneTrackItemAction(
          originalVideo, videoOffset,
          targetVideoTrackIndex - originalVideoTrackIndex,
          targetAudioTrackIndex - originalAudioTrackIndex, true, false
        ));
      }, "Gota Kit: crear segmento de video y audio");
    });
    if (!cloned) {
      throw new Error("Premiere no pudo duplicar el video con su audio.");
    }

    const locatedVideo = await waitForSilenceTrackItem(
      project, sequence, "video", targetVideoTrackIndex,
      timelineStart, mediaPath, sourceStart
    );
    if (!locatedVideo) {
      throw new Error(
        "Premiere creó el segmento, pero no pudo localizar el video duplicado."
      );
    }
    project = locatedVideo.project;
    sequence = locatedVideo.sequence;
    duplicateVideo = locatedVideo.item;
    const locatedAudio = await waitForSilenceTrackItem(
      project, sequence, "audio", targetAudioTrackIndex,
      timelineStart, mediaPath, sourceStart
    );
    duplicateAudio = locatedAudio ? locatedAudio.item : null;
    if (locatedAudio) {
      project = locatedAudio.project;
      sequence = locatedAudio.sequence;
    }
  }
  // Algunos montajes no conservan el vínculo interno (por ejemplo material
  // importado con audio separado). En ese caso duplicamos solamente su audio
  // como respaldo, siempre en la pista reservada para el segmento.
  if (!duplicateAudio) {
    // La clonación de vídeo pudo invalidar el objeto de audio original. Lo
    // recuperamos desde la secuencia viva antes de crear el respaldo.
    live = await getLiveSequenceContext(project, sequence);
    project = live.project;
    sequence = live.sequence;
    const originalAudioTrack = await sequence.getAudioTrack(originalAudioTrackIndex);
    const freshOriginalAudio = await findTrackItemBySource(
      originalAudioTrack,
      mediaPath,
      originalAudioInPoint.seconds,
      originalAudioStart.seconds
    );
    if (!freshOriginalAudio) {
      throw new Error("Premiere no pudo recuperar el audio original para el segmento.");
    }
    const fallbackEditor = ppro.SequenceEditor.getEditor(sequence);
    if (!fallbackEditor) {
      throw new Error("Premiere no pudo reabrir el editor para el audio del segmento.");
    }
    let audioCloned = false;
    project.lockedAccess(() => {
      audioCloned = project.executeTransaction((compoundAction) => {
        compoundAction.addAction(fallbackEditor.createCloneTrackItemAction(
          freshOriginalAudio, audioOffset, 0,
          targetAudioTrackIndex - originalAudioTrackIndex, false, false
        ));
      }, "Gota Kit: respaldo de audio del segmento");
    });
    if (!audioCloned) {
      throw new Error("Premiere no pudo duplicar el audio del segmento.");
    }
    const recoveredAudio = await waitForSilenceTrackItem(
      project, sequence, "audio", targetAudioTrackIndex,
      timelineStart, mediaPath, sourceStart
    );
    duplicateAudio = recoveredAudio ? recoveredAudio.item : null;
    if (recoveredAudio) {
      project = recoveredAudio.project;
      sequence = recoveredAudio.sequence;
    }
  }
  if (!duplicateAudio) {
    throw new Error(
      "Premiere creó el video, pero no pudo emparejar su audio."
    );
  }

  const timelineDuration = Math.max(
    0.001, (sourceEnd - sourceStart) / Math.max(0.001, speedFactor)
  );
  const timelineEnd = timelineStart + timelineDuration;
  let trimmed = false;
  project.lockedAccess(() => {
    trimmed = project.executeTransaction((compoundAction) => {
      for (const duplicate of [duplicateVideo, duplicateAudio]) {
        const inAction = duplicate.createSetInPointAction(
          ppro.TickTime.createWithSeconds(sourceStart)
        );
        const outAction = duplicate.createSetOutPointAction(
          ppro.TickTime.createWithSeconds(sourceEnd)
        );
        if (!inAction || !outAction) {
          throw new Error(
            "Premiere rechazó los límites del video o de su audio."
          );
        }
        compoundAction.addAction(inAction);
        compoundAction.addAction(outAction);
        if (typeof duplicate.createSetNameAction === "function") {
          const nameAction = duplicate.createSetNameAction(name);
          if (nameAction) compoundAction.addAction(nameAction);
        }
      }
    }, "Gota Kit: ajustar video y audio detectados");
  });
  if (!trimmed) {
    throw new Error("Premiere no pudo recortar el video con su audio.");
  }

  // Premiere debe terminar el trim antes de calcular correctamente el nuevo
  // inicio y final. En clips largos la colección puede tardar varios ciclos.
  const trimmedVideo = await waitForSilenceTrackItem(
    project, sequence, "video", targetVideoTrackIndex,
    timelineStart, mediaPath, sourceStart
  );
  const trimmedAudio = await waitForSilenceTrackItem(
    trimmedVideo ? trimmedVideo.project : project,
    trimmedVideo ? trimmedVideo.sequence : sequence,
    "audio", targetAudioTrackIndex, timelineStart, mediaPath, sourceStart
  );
  if (trimmedVideo) {
    project = trimmedVideo.project;
    sequence = trimmedVideo.sequence;
    duplicateVideo = trimmedVideo.item;
  } else {
    duplicateVideo = null;
  }
  if (trimmedAudio) {
    project = trimmedAudio.project;
    sequence = trimmedAudio.sequence;
    duplicateAudio = trimmedAudio.item;
  } else {
    duplicateAudio = null;
  }
  if (!duplicateVideo || !duplicateAudio) {
    // El corte sí se aplicó. Algunas ediciones de Premiere todavía no exponen
    // el TrackItem nuevo al terminar la transacción; abortar aquí dejaba el
    // resto del diálogo sin procesar. El bloque ya se creó en la pista
    // reservada y el siguiente segmento volverá a obtener una secuencia viva.
    return { video: null, audio: null, pendingVerification: true };
  }
  const trimmedVideoStart = await duplicateVideo.getStartTime();
  const trimmedAudioStart = await duplicateAudio.getStartTime();
  const videoMove = timelineStart - trimmedVideoStart.seconds;
  const audioMove = timelineStart - trimmedAudioStart.seconds;
  const needsMove =
    Math.abs(videoMove) > 0.000001 || Math.abs(audioMove) > 0.000001;
  let positioned = !needsMove;
  if (needsMove) project.lockedAccess(() => {
    positioned = project.executeTransaction((compoundAction) => {
      const moves = [
        [duplicateVideo, videoMove],
        [duplicateAudio, audioMove]
      ];
      for (const [duplicate, delta] of moves) {
        if (Math.abs(delta) <= 0.000001) continue;
        const moveAction = duplicate.createMoveAction(
          ppro.TickTime.createWithSeconds(delta)
        );
        if (!moveAction) {
          throw new Error(
            "Premiere rechazó la posición compactada del fragmento."
          );
        }
        compoundAction.addAction(moveAction);
      }
    }, "Gota Kit: cerrar hueco de video y audio");
  });
  if (!positioned) {
    throw new Error("Premiere no pudo cerrar el hueco del fragmento.");
  }

  const positionedVideo = await waitForSilenceTrackItem(
    project, sequence, "video", targetVideoTrackIndex,
    timelineStart, mediaPath, sourceStart
  );
  const positionedAudio = await waitForSilenceTrackItem(
    positionedVideo ? positionedVideo.project : project,
    positionedVideo ? positionedVideo.sequence : sequence,
    "audio", targetAudioTrackIndex, timelineStart, mediaPath, sourceStart
  );
  if (positionedVideo) {
    project = positionedVideo.project;
    sequence = positionedVideo.sequence;
    duplicateVideo = positionedVideo.item;
  } else {
    duplicateVideo = null;
  }
  if (positionedAudio) {
    project = positionedAudio.project;
    sequence = positionedAudio.sequence;
    duplicateAudio = positionedAudio.item;
  } else {
    duplicateAudio = null;
  }
  if (!duplicateVideo || !duplicateAudio) {
    return { video: null, audio: null, pendingVerification: true };
  }
  for (const duplicate of [duplicateVideo, duplicateAudio]) {
    const actualStart = await duplicate.getStartTime();
    const actualEnd = await duplicate.getEndTime();
    if (
      Math.abs(actualStart.seconds - timelineStart) > 0.05 ||
      Math.abs(actualEnd.seconds - timelineEnd) > 0.05
    ) {
      // No interrumpimos todo el lote por la confirmación de un solo bloque:
      // Premiere redondea algunos clips a cuadro y puede variar unos ticks.
      return { video: duplicateVideo, audio: duplicateAudio, pendingVerification: true };
    }
  }
  return { video: duplicateVideo, audio: duplicateAudio };
}

async function disableTrackItem(project, item, label) {
  if (!item || typeof item.createSetDisabledAction !== "function") {
    throw new Error(`Premiere no permite desactivar ${label}.`);
  }
  let disabled = false;
  project.lockedAccess(() => {
    disabled = project.executeTransaction((compoundAction) => {
      const action = item.createSetDisabledAction(true);
      if (!action) throw new Error(`Premiere rechazó desactivar ${label}.`);
      compoundAction.addAction(action);
    }, `AutoFrame: desactivar ${label}`);
  });
  if (!disabled) throw new Error(`No se pudo desactivar ${label}.`);
}

async function recordSilenceOperation(event, details = {}) {
  // El registro vive en el motor local, no dentro del proyecto. Así podemos
  // saber exactamente en qué fase de Premiere falló un montaje sin pedir al
  // usuario que adivine ni exponer la ruta completa de sus medios.
  try {
    const response = await fetch(`${SERVICE_URL}/v3/silence-diagnostics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, details })
    });
    const payload = await response.json().catch(() => ({}));
    return payload.diagnosticLogPath || "";
  } catch (_) {
    // El registro nunca debe detener la edición si el motor acaba de reiniciar.
    return "";
  }
}

async function suppressOriginalSilenceComponent(project, sequence, analysis, mediaKind) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt) await pauseForPremiere(140 * attempt);
    try {
      const live = await getLiveSequenceContext(project, sequence);
      let item = await findOriginalSilenceTrackItem(
        live.sequence, analysis.clip, mediaKind
      );
      if (!item && mediaKind === "audio") {
        item = await findMatchingAudioTrackItem(live.sequence, analysis.clip);
      }
      if (!item) return { changed: false, reason: "not-found" };
      await disableTrackItem(
        live.project,
        item,
        mediaKind === "video" ? "el video original" : "el audio original"
      );
      return { changed: true, reason: "disabled", attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Premiere no pudo desactivar el original.");
}

async function cloneTrimmedAudioSegment(
  project, sequence, originalAudio, sourceStart, sourceEnd,
  timelineStart, targetAudioTrackIndex, name
) {
  if (!originalAudio) {
    throw new Error("No se encontró el audio seleccionado.");
  }
  let live = await getLiveSequenceContext(project, sequence);
  project = live.project;
  sequence = live.sequence;
  const editor = ppro.SequenceEditor.getEditor(sequence);
  if (!editor) throw new Error("Premiere no pudo abrir el editor de audio.");
  const originalStart = await originalAudio.getStartTime();
  const sourceItem = await originalAudio.getProjectItem();
  const sourceMedia = ppro.ClipProjectItem.cast(sourceItem);
  const mediaPath = await sourceMedia.getMediaFilePath();
  const originalTrackIndex = await originalAudio.getTrackIndex();
  const offset = ppro.TickTime.createWithSeconds(timelineStart - originalStart.seconds);
  let cloned = false;
  project.lockedAccess(() => {
    cloned = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(editor.createCloneTrackItemAction(
        originalAudio, offset, 0,
        targetAudioTrackIndex - originalTrackIndex, false, false
      ));
    }, "Gota Kit: crear segmento de audio");
  });
  if (!cloned) throw new Error("Premiere no pudo duplicar el audio.");
  const locatedAudio = await waitForSilenceTrackItem(
    project, sequence, "audio", targetAudioTrackIndex,
    timelineStart, mediaPath, sourceStart
  );
  project = locatedAudio ? locatedAudio.project : project;
  sequence = locatedAudio ? locatedAudio.sequence : sequence;
  let duplicate = locatedAudio ? locatedAudio.item : null;
  if (!duplicate) throw new Error("Premiere no pudo localizar el audio duplicado.");
  let trimmed = false;
  project.lockedAccess(() => {
    trimmed = project.executeTransaction((compoundAction) => {
      const inAction = duplicate.createSetInPointAction(
        ppro.TickTime.createWithSeconds(sourceStart)
      );
      const outAction = duplicate.createSetOutPointAction(
        ppro.TickTime.createWithSeconds(sourceEnd)
      );
      if (!inAction || !outAction) throw new Error("Premiere rechazó el recorte de audio.");
      compoundAction.addAction(inAction);
      compoundAction.addAction(outAction);
      if (typeof duplicate.createSetNameAction === "function") {
        const nameAction = duplicate.createSetNameAction(name);
        if (nameAction) compoundAction.addAction(nameAction);
      }
    }, "Gota Kit: ajustar segmento de audio");
  });
  if (!trimmed) throw new Error("Premiere no pudo recortar el audio.");
  const trimmedAudio = await waitForSilenceTrackItem(
    project, sequence, "audio", targetAudioTrackIndex,
    timelineStart, mediaPath, sourceStart
  );
  project = trimmedAudio ? trimmedAudio.project : project;
  sequence = trimmedAudio ? trimmedAudio.sequence : sequence;
  duplicate = trimmedAudio ? trimmedAudio.item : null;
  // Al igual que con video, el recorte ya quedó aplicado aunque Premiere no
  // entregue de inmediato el nuevo TrackItem. No detenemos el resto del lote.
  if (!duplicate) return null;
  const trimmedStart = await duplicate.getStartTime();
  const correction = timelineStart - trimmedStart.seconds;
  if (Math.abs(correction) > 0.000001) {
    let moved = false;
    project.lockedAccess(() => {
      moved = project.executeTransaction((compoundAction) => {
        const action = duplicate.createMoveAction(
          ppro.TickTime.createWithSeconds(correction)
        );
        if (!action) throw new Error("Premiere rechazó mover el audio.");
        compoundAction.addAction(action);
      }, "Gota Kit: cerrar hueco de audio");
    });
    if (!moved) throw new Error("Premiere no pudo compactar el audio.");
  }
  // No devolvemos una referencia usada dentro de una transacción: para el
  // siguiente corte se vuelve a localizar el elemento desde la secuencia viva.
  return null;
}

async function cloneSilenceKeptSegment(
  project, sequence, analysis, sourceStart, sourceEnd, timelineStart,
  reservedDestinations = null
) {
  // Cada reintento vuelve a encontrar el video y audio de origen. No basta
  // con reintentar el clon: si Premiere ya reconstruyó la secuencia, los
  // TrackItem recibidos en el intento anterior también están vencidos.
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (attempt) await pauseForPremiere(Math.min(900, 180 * (attempt + 1)));
      const recovered = await recoverSilenceSourcePair(
        project, sequence, analysis.clip
      );
      project = recovered.project;
      sequence = recovered.sequence;
      const originalVideo = recovered.originalVideo;
      const originalAudio = recovered.originalAudio;
      const timelineScale = Number(analysis.clip.sourceToTimelineScale || 1);
      const timelineEnd = timelineStart +
        Math.max(0.001, (sourceEnd - sourceStart) * timelineScale);
      const destinations = reservedDestinations ||
        await pickSilenceDestinationTracks(
          sequence, originalVideo, originalAudio, timelineStart, timelineEnd
        );
      const name = `DIÁLOGO ${formatTimecode(timelineStart)}`;
      if (!originalVideo) {
        return await cloneTrimmedAudioSegment(
          project, sequence, originalAudio, sourceStart, sourceEnd,
          timelineStart, destinations.audioTrackIndex, name
        );
      }
      return await cloneTrimmedSegmentOnce(
        project, sequence, originalVideo, originalAudio, sourceStart, sourceEnd,
        timelineStart, destinations.videoTrackIndex, destinations.audioTrackIndex, name
      );
    } catch (error) {
      lastError = error;
      if (!isPremiereReferenceExpired(error)) throw error;
    }
  }
  throw new Error(
    `Premiere perdió la referencia del segmento ${formatTimecode(timelineStart)} ` +
    `después de cinco intentos: ${lastError?.message || String(lastError)}`
  );
}

async function removeOriginalSilenceComponent(project, sequence, analysis, mediaKind) {
  // Un TrackItem deja de ser válido cada vez que Premiere reconstruye una
  // pista. Retiramos vídeo y audio en transacciones independientes y volvemos
  // a localizar cada uno antes de tocarlo. Esto evita que borrar el vídeo
  // invalide la referencia de su audio enlazado.
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
      const live = await getLiveSequenceContext(project, sequence);
      let item = await findOriginalSilenceTrackItem(
        live.sequence, analysis.clip, mediaKind
      );
      if (!item && mediaKind === "audio") {
        item = await findMatchingAudioTrackItem(live.sequence, analysis.clip);
      }
      // Si el vídeo enlazado ya retiró también su audio, no hay nada pendiente.
      if (!item) return 0;
      const editor = ppro.SequenceEditor.getEditor(live.sequence);
      if (!editor) throw new Error("Premiere no pudo abrir el editor de la secuencia.");
      let removed = false;
      live.project.lockedAccess(() => {
        removed = live.project.executeTransaction((compoundAction) => {
          // La selección se crea dentro de la transacción. Premiere puede
          // invalidarla cuando se crea entre operaciones de edición.
          const selection = createEmptyTrackSelectionNow();
          if (!selection.addItem(item, false)) {
            throw new Error("Premiere no pudo preparar el original para retirarlo.");
          }
          const action = editor.createRemoveItemsAction(
            selection, false, ppro.Constants.MediaType.ANY, false
          );
          if (!action) throw new Error("Premiere no preparó el retiro del original.");
          compoundAction.addAction(action);
        }, `Gota Kit: retirar ${mediaKind} original tras compactar silencios`);
      });
      if (removed) return 1;
      lastError = new Error("Premiere rechazó retirar el original.");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Premiere no pudo retirar el material original.");
}

async function removeOriginalSilencePair(project, sequence, analysis) {
  // Premiere maneja vídeo y audio vinculados como una sola unidad. Quitarlos
  // por separado puede invalidar el segundo TrackItem, que era exactamente la
  // causa del mensaje "The script object is no longer valid". Primero
  // intentamos un único retiro con los dos elementos frescos en una misma
  // transacción. Si la pareja no está vinculada, el respaldo anterior seguirá
  // intentando quitarlos uno por uno.
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 220 * attempt));
      const live = await getLiveSequenceContext(project, sequence);
      const video = analysis.clip.mediaKind === "audio"
        ? null
        : await findOriginalSilenceTrackItem(live.sequence, analysis.clip, "video");
      let audio = await findOriginalSilenceTrackItem(
        live.sequence, analysis.clip, "audio"
      );
      if (!audio) audio = await findMatchingAudioTrackItem(live.sequence, analysis.clip);
      if (!video && !audio) return { removed: 0, alreadyGone: true };

      const editor = ppro.SequenceEditor.getEditor(live.sequence);
      if (!editor) throw new Error("Premiere no pudo abrir el editor de la secuencia.");
      let removed = false;
      let selectedCount = 0;
      live.project.lockedAccess(() => {
        removed = live.project.executeTransaction((compoundAction) => {
          // Selección, elementos y acción nacen en la misma transacción. Así
          // no sobreviven referencias de TrackItem de un corte anterior.
          const selection = createEmptyTrackSelectionNow();
          if (video && selection.addItem(video, false)) selectedCount += 1;
          if (audio && selection.addItem(audio, false)) selectedCount += 1;
          if (!selectedCount) {
            throw new Error("Premiere no pudo preparar los originales para retirarlos.");
          }
          const action = editor.createRemoveItemsAction(
            selection, false, ppro.Constants.MediaType.ANY, false
          );
          if (!action) throw new Error("Premiere no preparó el retiro del material original.");
          compoundAction.addAction(action);
        }, "Gota Kit: retirar video y audio originales tras compactar silencios");
      });
      if (removed) return { removed: selectedCount, alreadyGone: false };
      lastError = new Error("Premiere rechazó retirar el material original.");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Premiere no pudo retirar los originales.");
}

async function removeOriginalSilenceClip(project, sequence, analysis) {
  // No eliminamos físicamente el original durante la misma operación que
  // crea, recorta y mueve los nuevos bloques. En varias versiones de Premiere
  // (sobre todo macOS) ese último borrado reconstruye las pistas e invalida los
  // TrackItem recién creados: el resultado era el aviso "script object is no
  // longer valid" y una edición a medias. En su lugar lo desactivamos con
  // referencias frescas; visual y auditivamente equivale a retirarlo, mantiene
  // el audio/vídeo sincronizados y deja un Deshacer completamente seguro.
  let disabled = 0;
  const failures = [];
  const parts = analysis.clip.mediaKind === "audio" ? ["audio"] : ["video", "audio"];
  for (const mediaKind of parts) {
    try {
      const result = await suppressOriginalSilenceComponent(
        project, sequence, analysis, mediaKind
      );
      if (result.changed) disabled += 1;
      await recordSilenceOperation("original_suppressed", {
        mediaKind,
        clipName: analysis.clip.name,
        result: result.reason
      });
    } catch (error) {
      failures.push(`${mediaKind}: ${error.message || String(error)}`);
      await recordSilenceOperation("original_suppression_failed", {
        mediaKind,
        clipName: analysis.clip.name,
        error: error.message || String(error)
      });
    }
  }
  return {
    removed: 0,
    disabled,
    cleanupError: failures.length ? new Error(failures.join(" | ")) : null
  };
}

async function applySilenceEdit(project, sequence, analyses, mode) {
  const removalSummary = { removed: 0, disabled: 0, pendingCleanup: 0 };
  for (const analysis of analyses) {
    let live = await getLiveSequenceContext(project, sequence);
    project = live.project;
    sequence = live.sequence;
    const audioOnly = analysis.clip.mediaKind === "audio";
    const initialOriginal = audioOnly
      ? null
      : await findClonedTrackItem(sequence, analysis.clip);
    const initialOriginalAudio = await findMatchingAudioTrackItem(
      sequence, analysis.clip
    );
    if ((!audioOnly && !initialOriginal) || !initialOriginalAudio) {
      throw new Error(
        `No se encontró el audio vinculado de ${analysis.clip.name}.`
      );
    }
    // Se reserva una sola pareja de pistas para todo el tramo del clip. De
    // esta forma todos los cortes permanecen juntos, no pisan la edición que
    // ya exista y los segmentos de video y audio siguen el mismo destino.
    const reservedDestinations = await pickSilenceDestinationTracks(
      sequence,
      initialOriginal,
      initialOriginalAudio,
      analysis.clip.startSeconds,
      analysis.clip.endSeconds
    );
    await recordSilenceOperation("edit_started", {
      mode,
      clipName: analysis.clip.name,
      mediaKind: analysis.clip.mediaKind,
      sourceStart: analysis.clip.inPointSeconds,
      sourceEnd: analysis.clip.outPointSeconds,
      timelineStart: analysis.clip.startSeconds,
      timelineEnd: analysis.clip.endSeconds,
      videoTrack: analysis.clip.trackIndex,
      audioTrack: analysis.clip.audioTrackIndex,
      destinationVideoTrack: reservedDestinations.videoTrackIndex,
      destinationAudioTrack: reservedDestinations.audioTrackIndex,
      keptSegments: analysis.result.keptSegments?.length || 0,
      silenceSegments: analysis.result.silenceCount || 0
    });
    if (mode === "review") {
      const timeScale = Number(analysis.clip.sourceToTimelineScale || 1);
      for (let segmentIndex = 0; segmentIndex < analysis.result.keptSegments.length; segmentIndex += 1) {
        const kept = analysis.result.keptSegments[segmentIndex];
        live = await getLiveSequenceContext(project, sequence);
        project = live.project;
        sequence = live.sequence;
        const localStart = kept.startSeconds - analysis.clip.inPointSeconds;
        const timelineStart =
          analysis.clip.startSeconds + localStart * timeScale;
        await cloneSilenceKeptSegment(
          project, sequence, analysis,
          kept.startSeconds, kept.endSeconds, timelineStart,
          reservedDestinations
        );
        // Cada bloque de ocho segmentos cedemos un instante a Premiere para
        // que reconstruya sus colecciones. No es un límite: permite procesar
        // clips de cualquier duración sin acumular referencias vencidas.
        // En clips muy largos cedemos el ciclo de interfaz después de cada
        // bloque. No limita su duración: evita que Premiere acumule objetos
        // de pista vencidos mientras recompone la secuencia.
        const longEdit = analysis.result.keptSegments.length > 24;
        if (longEdit || (segmentIndex + 1) % 3 === 0) {
          await pauseForPremiere(longEdit ? 280 : 220);
        }
      }
      if (!audioOnly) {
        live = await getLiveSequenceContext(project, sequence);
        project = live.project;
        sequence = live.sequence;
        const currentOriginal = await findClonedTrackItem(
          sequence, analysis.clip
        );
        await disableTrackItem(project, currentOriginal, "el clip original");
      }
      live = await getLiveSequenceContext(project, sequence);
      project = live.project;
      sequence = live.sequence;
      const currentOriginalAudio = await findMatchingAudioTrackItem(
        sequence, analysis.clip
      );
      await disableTrackItem(
        project, currentOriginalAudio, "el audio original"
      );
    } else {
      const timeScale = Number(analysis.clip.sourceToTimelineScale || 1);
      if (!analysis.result.keptSegments || !analysis.result.keptSegments.length) {
        throw new Error(
          `No se encontró diálogo que conservar en ${analysis.clip.name}; el original no se modificó.`
        );
      }
      let compactedStart = analysis.clip.startSeconds;
      for (let segmentIndex = 0; segmentIndex < analysis.result.keptSegments.length; segmentIndex += 1) {
        const kept = analysis.result.keptSegments[segmentIndex];
        live = await getLiveSequenceContext(project, sequence);
        project = live.project;
        sequence = live.sequence;
        try {
          const created = await cloneSilenceKeptSegment(
            project, sequence, analysis,
            kept.startSeconds, kept.endSeconds, compactedStart,
            reservedDestinations
          );
          // Para clips largos guardamos puntos de control útiles, no cientos
          // de peticiones locales que pueden retrasar a Premiere. El primer,
          // cada décimo y el último segmento bastan para diagnosticar un fallo.
          if (
            segmentIndex === 0 ||
            (segmentIndex + 1) % 10 === 0 ||
            segmentIndex + 1 === analysis.result.keptSegments.length
          ) {
            await recordSilenceOperation("segment_checkpoint", {
              clipName: analysis.clip.name,
              segmentIndex: segmentIndex + 1,
              totalSegments: analysis.result.keptSegments.length,
              sourceStart: kept.startSeconds,
              sourceEnd: kept.endSeconds,
              timelineStart: compactedStart,
              pendingVerification: !!created?.pendingVerification
            });
          }
        } catch (error) {
          await recordSilenceOperation("segment_failed", {
            clipName: analysis.clip.name,
            segmentIndex: segmentIndex + 1,
            sourceStart: kept.startSeconds,
            sourceEnd: kept.endSeconds,
            timelineStart: compactedStart,
            error: error.message || String(error)
          });
          throw error;
        }
        compactedStart += kept.durationSeconds * timeScale;
        const longEdit = analysis.result.keptSegments.length > 24;
        if (longEdit || (segmentIndex + 1) % 3 === 0) {
          await pauseForPremiere(longEdit ? 280 : 220);
        }
      }
      // Ahora que todos los fragmentos están unidos en pistas nuevas, retiramos
      // video y audio de la pista fuente. Antes se hacía en un lote global y
      // una referencia vencida dejaba el original debajo del resultado.
      const removal = await removeOriginalSilenceClip(project, sequence, analysis);
      removalSummary.removed += removal.removed || 0;
      removalSummary.disabled += removal.disabled || 0;
      if (removal.cleanupError) removalSummary.pendingCleanup += 1;
      await recordSilenceOperation("edit_completed", {
        clipName: analysis.clip.name,
        disabledOriginalParts: removal.disabled || 0,
        cleanupWarning: removal.cleanupError ? removal.cleanupError.message : ""
      });
    }
  }

  return {
    sequence: (await getLiveSequenceContext(project, sequence)).sequence,
    removalSummary
  };
}

function makeElement(tag, text) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  return element;
}

function formatTimecode(totalSeconds) {
  const safeSeconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  const two = (value) => String(value).padStart(2, "0");
  return hours > 0
    ? `${two(hours)}:${two(minutes)}:${two(seconds)}`
    : `${two(minutes)}:${two(seconds)}`;
}

function formatRemainingTime(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 5) return "menos de 5 s";
  return formatTimecode(seconds);
}

function estimateRemainingSeconds(startedAt, progressPercent) {
  const progress = Number(progressPercent) || 0;
  if (progress < 2) return null;
  const elapsed = (Date.now() - startedAt) / 1000;
  return Math.max(0, elapsed * (100 - progress) / progress);
}

function buildPanel() {
  const panel = makeElement("div");
  panel.style.padding = "16px";
  panel.style.display = "flex";
  panel.style.flexDirection = "column";
  panel.style.gap = "12px";
  panel.style.color = "#f5f5f5";
  panel.style.height = "100%";
  panel.style.maxHeight = "100vh";
  panel.style.minHeight = "0";
  panel.style.boxSizing = "border-box";
  panel.style.overflowY = "scroll";
  panel.style.overflowX = "hidden";

  const title = makeElement("h2", "Gota Creator Kit ☔");
  title.style.margin = "0";
  title.style.fontSize = "18px";
  panel.appendChild(title);
  panel.appendChild(makeElement("div", "Selecciona uno o mas clips de video."));

  const aspectLabel = makeElement("label", "Formato");
  const aspect = makeElement("select");
  aspect.id = "aspect";
  [
    ["0.5625", "Vertical 9:16"],
    ["1.7777778", "Horizontal 16:9"],
    ["1", "Cuadrado 1:1"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    aspect.appendChild(option);
  });
  aspectLabel.appendChild(aspect);
  panel.appendChild(aspectLabel);

  const modeLabel = makeElement("label", "Modo");
  const mode = makeElement("select");
  const podcastOption = makeElement("option", "Podcast vertical (1 o 2 personas)");
  podcastOption.value = "podcast";
  mode.appendChild(podcastOption);
  const multicamOption = makeElement(
    "option", "Multicamara automatica (2 a 4 camaras)"
  );
  multicamOption.value = "multicam";
  mode.appendChild(multicamOption);
  modeLabel.appendChild(mode);
  panel.appendChild(modeLabel);

  const speedLabel = makeElement("label", "Velocidad de analisis");
  const speed = makeElement("select");
  [
    ["4", "Preciso 2.0 (4 muestras/segundo)"],
    ["2", "Equilibrado 2.0 (2 muestras/segundo)"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    speed.appendChild(option);
  });
  speedLabel.appendChild(speed);
  panel.appendChild(speedLabel);

  const presetLabel = makeElement("label", "Preset");
  const preset = makeElement("select");
  [
    ["gota", "Podcast Gota"],
    ["interview", "Entrevista tranquila"],
    ["reels", "TikTok / Reel dinamico"],
    ["custom", "Personalizado"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    preset.appendChild(option);
  });
  presetLabel.appendChild(preset);
  panel.appendChild(presetLabel);

  const profileLabel = makeElement("label", "Ritmo de edicion");
  const profile = makeElement("select");
  [
    ["camera_shots", "Por cambios de camara"],
    ["podcast_calm", "Podcast tranquilo"],
    ["podcast_dynamic", "Podcast dinamico"],
    ["reels_fast", "Reels rapidos"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    profile.appendChild(option);
  });
  profile.value = "podcast_dynamic";
  profileLabel.appendChild(profile);
  panel.appendChild(profileLabel);

  const minShotLabel = makeElement("label", "Duracion minima de plano");
  const minShot = makeElement("select");
  [
    ["1", "1 segundo"],
    ["1.8", "1.8 segundos (recomendado)"],
    ["3", "3 segundos"],
    ["5", "5 segundos"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    minShot.appendChild(option);
  });
  minShot.value = "1.8";
  minShotLabel.appendChild(minShot);
  panel.appendChild(minShotLabel);

  const speakerDelayLabel = makeElement("label", "Espera antes de cambiar");
  const speakerDelay = makeElement("select");
  [
    ["0.2", "Rapida (0.2 s)"],
    ["0.4", "Natural (0.4 s)"],
    ["0.7", "Segura (0.7 s)"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    speakerDelay.appendChild(option);
  });
  speakerDelay.value = "0.4";
  speakerDelayLabel.appendChild(speakerDelay);
  panel.appendChild(speakerDelayLabel);

  const sensitivityLabel = makeElement("label", "Detector facial");
  const sensitivity = makeElement("select");
  [
    ["strict", "Estricto (evita logos y dibujos)"],
    ["balanced", "Equilibrado (recomendado)"],
    ["permissive", "Flexible (perfiles dificiles)"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    sensitivity.appendChild(option);
  });
  sensitivity.value = "strict";
  sensitivityLabel.appendChild(sensitivity);
  panel.appendChild(sensitivityLabel);

  const peopleLabel = makeElement("label", "Composicion");
  const peopleMode = makeElement("select");
  [
    ["auto", "Automatica"],
    ["single", "Siempre una persona"],
    ["split", "Dos personas cuando se confirmen"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    peopleMode.appendChild(option);
  });
  peopleLabel.appendChild(peopleMode);
  panel.appendChild(peopleLabel);

  const framingLabel = makeElement("label", "Encuadre");
  const framing = makeElement("select");
  [
    ["1.0", "Cerrado (rostro y hombros)"],
    ["1.2", "Medio (recomendado)"],
    ["1.45", "Amplio (mas ambiente)"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    framing.appendChild(option);
  });
  framing.value = "1.2";
  framingLabel.appendChild(framing);
  panel.appendChild(framingLabel);

  const editStyleLabel = makeElement("label", "Tipo de edicion");
  const editStyle = makeElement("select");
  [
    ["cuts", "Solo cortes (ajuste manual facil)"],
    ["keyframes", "Seguimiento con keyframes"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    editStyle.appendChild(option);
  });
  editStyleLabel.appendChild(editStyle);
  panel.appendChild(editStyleLabel);

  const analyze = makeElement("div", "Analizar seleccion");
  analyze.id = "analyze";
  analyze.setAttribute("role", "button");
  analyze.setAttribute("tabindex", "0");
  analyze.style.height = "36px";
  analyze.style.display = "flex";
  analyze.style.alignItems = "center";
  analyze.style.justifyContent = "center";
  analyze.style.borderRadius = "9px";
  analyze.style.fontWeight = "600";
  analyze.style.color = "#ffffff";
  analyze.style.userSelect = "none";
  panel.appendChild(analyze);

  const cancel = makeElement("div", "Cancelar analisis");
  cancel.setAttribute("role", "button");
  cancel.setAttribute("tabindex", "0");
  cancel.style.height = "30px";
  cancel.style.display = "none";
  cancel.style.alignItems = "center";
  cancel.style.justifyContent = "center";
  cancel.style.borderRadius = "8px";
  cancel.style.backgroundColor = "#8f2f2f";
  cancel.style.color = "#ffffff";
  cancel.style.cursor = "pointer";
  panel.appendChild(cancel);

  const apply = makeElement("div", "Crear copia vertical con reencuadre");
  apply.setAttribute("role", "button");
  apply.setAttribute("tabindex", "0");
  apply.style.height = "36px";
  apply.style.display = "flex";
  apply.style.alignItems = "center";
  apply.style.justifyContent = "center";
  apply.style.borderRadius = "9px";
  apply.style.fontWeight = "600";
  apply.style.color = "#ffffff";
  apply.style.userSelect = "none";
  apply.style.backgroundColor = "#555555";
  apply.style.opacity = "0.55";
  panel.appendChild(apply);

  const progress = makeElement("progress");
  progress.max = 100;
  progress.value = 0;
  progress.style.width = "100%";
  progress.style.height = "14px";
  panel.appendChild(progress);

  const percent = makeElement("div", "0%");
  percent.style.textAlign = "center";
  percent.style.fontWeight = "bold";
  panel.appendChild(percent);

  const status = makeElement(
    "div",
    "Gota Creator Kit ☔ listo. Selecciona un clip para comenzar."
  );
  status.id = "status";
  status.style.padding = "10px";
  status.style.backgroundColor = "#181818";
  status.style.whiteSpace = "pre-wrap";
  panel.appendChild(status);

  const review = makeElement("div", "Revision pendiente.");
  review.style.display = "none";
  review.style.padding = "10px";
  review.style.backgroundColor = "#20252b";
  review.style.border = "1px solid #3b4652";
  review.style.borderRadius = "6px";
  review.style.whiteSpace = "pre-wrap";
  panel.appendChild(review);

  const shotEditor = makeElement("div");
  shotEditor.style.display = "none";
  shotEditor.style.flexDirection = "column";
  shotEditor.style.gap = "8px";
  panel.appendChild(shotEditor);

  const reframeHeading = makeElement("div");
  reframeHeading.style.fontWeight = "bold";
  reframeHeading.style.padding = "8px";
  reframeHeading.style.backgroundColor = "#20252b";
  reframeHeading.style.border = "1px solid #3b4652";
  reframeHeading.style.borderRadius = "6px";
  reframeHeading.style.cursor = "pointer";
  reframeHeading.style.userSelect = "none";
  panel.appendChild(reframeHeading);

  const reframeBody = makeElement("div");
  reframeBody.style.flexDirection = "column";
  reframeBody.style.gap = "12px";
  reframeBody.style.flexShrink = "0";
  panel.appendChild(reframeBody);
  [
    aspectLabel, modeLabel, speedLabel, presetLabel, profileLabel,
    minShotLabel, speakerDelayLabel, sensitivityLabel, peopleLabel,
    framingLabel, editStyleLabel, analyze, cancel, apply, progress,
    percent, status, review, shotEditor
  ].forEach((control) => reframeBody.appendChild(control));

  let reframeCollapsed = false;
  try {
    reframeCollapsed =
      window.localStorage.getItem("autoframeReframeCollapsed") === "true";
  } catch (_) {
    // El reencuadre comienza abierto si no hay almacenamiento.
  }
  const updateReframeCollapsed = () => {
    reframeHeading.textContent =
      `${reframeCollapsed ? "▶" : "▼"} Reencuadre automático`;
    reframeBody.style.display = reframeCollapsed ? "none" : "flex";
  };
  reframeHeading.addEventListener("click", () => {
    reframeCollapsed = !reframeCollapsed;
    updateReframeCollapsed();
    try {
      window.localStorage.setItem(
        "autoframeReframeCollapsed", String(reframeCollapsed)
      );
    } catch (_) {
      // El plegado sigue funcionando durante esta sesión.
    }
  });
  updateReframeCollapsed();

  const silencePanel = makeElement("div");
  silencePanel.style.display = "flex";
  silencePanel.style.flexDirection = "column";
  silencePanel.style.gap = "8px";
  silencePanel.style.marginTop = "4px";
  panel.appendChild(silencePanel);

  let silenceCollapsed = true;
  try {
    silenceCollapsed =
      window.localStorage.getItem("autoframeSilenceCollapsed") !== "false";
  } catch (_) {
    // El panel comienza plegado si no hay almacenamiento.
  }
  const silenceHeading = makeElement("div");
  silenceHeading.style.fontWeight = "bold";
  silenceHeading.style.padding = "8px";
  silenceHeading.style.backgroundColor = "#20252b";
  silenceHeading.style.border = "1px solid #3b4652";
  silenceHeading.style.borderRadius = "6px";
  silenceHeading.style.cursor = "pointer";
  silenceHeading.style.userSelect = "none";
  silencePanel.appendChild(silenceHeading);

  const silenceBody = makeElement("div");
  silenceBody.style.flexDirection = "column";
  silenceBody.style.gap = "8px";
  silencePanel.appendChild(silenceBody);
  const updateSilenceCollapsed = () => {
    silenceHeading.textContent =
      `${silenceCollapsed ? "▶" : "▼"} Eliminar silencios`;
    silenceBody.style.display = silenceCollapsed ? "none" : "flex";
  };
  silenceHeading.addEventListener("click", () => {
    silenceCollapsed = !silenceCollapsed;
    updateSilenceCollapsed();
    try {
      window.localStorage.setItem(
        "autoframeSilenceCollapsed", String(silenceCollapsed)
      );
    } catch (_) {
      // El plegado sigue funcionando durante esta sesión.
    }
  });

  const silenceHelp = makeElement(
    "div",
    "Detecta pausas por volumen y aplica el resultado a la secuencia activa. " +
    "Guarda el proyecto antes de continuar."
  );
  silenceHelp.style.color = "#b8b8b8";
  silenceHelp.style.fontSize = "10px";
  silenceBody.appendChild(silenceHelp);

  const thresholdLabel = makeElement("label", "Nivel considerado silencio");
  const thresholdPreset = makeElement("select");
  [
    ["-30", "-30 dB (agresivo)"],
    ["-36", "-36 dB"],
    ["-42", "-42 dB (recomendado)"],
    ["-48", "-48 dB"],
    ["-54", "-54 dB (conservador)"],
    ["-60", "-60 dB (solo silencio claro)"],
    ["custom", "Valor personalizado"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    thresholdPreset.appendChild(option);
  });
  thresholdPreset.value = "-42";
  thresholdLabel.appendChild(thresholdPreset);

  const thresholdInputRow = makeElement("div");
  thresholdInputRow.style.display = "flex";
  thresholdInputRow.style.alignItems = "center";
  thresholdInputRow.style.gap = "7px";
  thresholdInputRow.style.marginTop = "5px";
  const thresholdInput = makeElement("input");
  thresholdInput.type = "number";
  thresholdInput.min = "-96";
  thresholdInput.max = "0";
  thresholdInput.step = "0.5";
  thresholdInput.value = "-42";
  thresholdInput.placeholder = "-42";
  thresholdInput.style.flex = "1";
  thresholdInput.style.minWidth = "0";
  const thresholdUnit = makeElement("span", "dB");
  thresholdUnit.style.color = "#b8b8b8";
  thresholdInputRow.appendChild(thresholdInput);
  thresholdInputRow.appendChild(thresholdUnit);
  thresholdLabel.appendChild(thresholdInputRow);
  const thresholdHint = makeElement(
    "div", "Puedes escribir cualquier valor entre -96 y 0 dB."
  );
  thresholdHint.style.fontSize = "9px";
  thresholdHint.style.color = "#888888";
  thresholdHint.style.marginTop = "3px";
  thresholdLabel.appendChild(thresholdHint);
  silenceBody.appendChild(thresholdLabel);

  thresholdPreset.addEventListener("change", () => {
    if (thresholdPreset.value !== "custom") {
      thresholdInput.value = thresholdPreset.value;
    }
  });
  thresholdInput.addEventListener("input", () => {
    const matchingPreset = Array.from(thresholdPreset.children).find(
      (option) => option.value === thresholdInput.value
    );
    thresholdPreset.value = matchingPreset
      ? matchingPreset.value
      : "custom";
  });

  const minimumSilenceLabel = makeElement("label", "Duración mínima");
  const minimumSilence = makeElement("select");
  [
    ["0.25", "0.25 s (cortes rápidos)"],
    ["0.4", "0.40 s (recomendado)"],
    ["0.6", "0.60 s"],
    ["1", "1.00 s"],
    ["1.5", "1.50 s (solo pausas largas)"],
    ["custom", "Valor personalizado"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    minimumSilence.appendChild(option);
  });
  minimumSilence.value = "0.4";
  minimumSilenceLabel.appendChild(minimumSilence);
  const minimumSilenceInput = makeElement("input");
  minimumSilenceInput.type = "number";
  minimumSilenceInput.min = "0.1";
  minimumSilenceInput.max = "5";
  minimumSilenceInput.step = "0.05";
  minimumSilenceInput.value = "0.4";
  minimumSilenceInput.style.marginTop = "5px";
  minimumSilenceInput.style.width = "100%";
  minimumSilenceInput.style.boxSizing = "border-box";
  minimumSilenceLabel.appendChild(minimumSilenceInput);
  const minimumHint = makeElement(
    "div", "Personaliza de 0.10 a 5.00 segundos."
  );
  minimumHint.style.fontSize = "9px";
  minimumHint.style.color = "#888888";
  minimumHint.style.marginTop = "3px";
  minimumSilenceLabel.appendChild(minimumHint);
  silenceBody.appendChild(minimumSilenceLabel);
  minimumSilence.addEventListener("change", () => {
    if (minimumSilence.value !== "custom") {
      minimumSilenceInput.value = minimumSilence.value;
    }
  });
  minimumSilenceInput.addEventListener("input", () => {
    const option = Array.from(minimumSilence.children).find(
      (item) => item.value === minimumSilenceInput.value
    );
    minimumSilence.value = option ? option.value : "custom";
  });

  const paddingLabel = makeElement("label", "Protección de palabras");
  const silencePadding = makeElement("select");
  [
    ["0.05", "Corta (0.05 s)"],
    ["0.12", "Natural (0.12 s)"],
    ["0.2", "Segura (0.20 s)"],
    ["0.3", "Muy segura (0.30 s)"],
    ["custom", "Valor personalizado"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    silencePadding.appendChild(option);
  });
  silencePadding.value = "0.12";
  paddingLabel.appendChild(silencePadding);
  const silencePaddingInput = makeElement("input");
  silencePaddingInput.type = "number";
  silencePaddingInput.min = "0";
  silencePaddingInput.max = "1";
  silencePaddingInput.step = "0.01";
  silencePaddingInput.value = "0.12";
  silencePaddingInput.style.marginTop = "5px";
  silencePaddingInput.style.width = "100%";
  silencePaddingInput.style.boxSizing = "border-box";
  paddingLabel.appendChild(silencePaddingInput);
  const paddingHint = makeElement(
    "div", "Personaliza de 0 a 1 segundo por lado del corte."
  );
  paddingHint.style.fontSize = "9px";
  paddingHint.style.color = "#888888";
  paddingHint.style.marginTop = "3px";
  paddingLabel.appendChild(paddingHint);
  silenceBody.appendChild(paddingLabel);
  silencePadding.addEventListener("change", () => {
    if (silencePadding.value !== "custom") {
      silencePaddingInput.value = silencePadding.value;
    }
  });
  silencePaddingInput.addEventListener("input", () => {
    const option = Array.from(silencePadding.children).find(
      (item) => item.value === silencePaddingInput.value
    );
    silencePadding.value = option ? option.value : "custom";
  });

  const silenceModeLabel = makeElement("label", "Qué hacer con los silencios");
  const silenceMode = makeElement("select");
  [
    ["delete", "Cortar silencios y moverlos (sin huecos)"],
    ["review", "Vista previa en pista superior"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", label);
    option.value = value;
    silenceMode.appendChild(option);
  });
  silenceModeLabel.appendChild(silenceMode);
  silenceBody.appendChild(silenceModeLabel);

  const analyzeSilence = makeElement("div", "Analizar silencios");
  analyzeSilence.setAttribute("role", "button");
  analyzeSilence.setAttribute("tabindex", "0");
  analyzeSilence.style.height = "34px";
  analyzeSilence.style.display = "flex";
  analyzeSilence.style.alignItems = "center";
  analyzeSilence.style.justifyContent = "center";
  analyzeSilence.style.borderRadius = "8px";
  analyzeSilence.style.backgroundColor = "#1473e6";
  analyzeSilence.style.fontWeight = "600";
  analyzeSilence.style.cursor = "pointer";
  silenceBody.appendChild(analyzeSilence);

  const applySilence = makeElement("div", "Aplicar a la secuencia activa");
  applySilence.setAttribute("role", "button");
  applySilence.setAttribute("tabindex", "0");
  applySilence.style.height = "34px";
  applySilence.style.display = "flex";
  applySilence.style.alignItems = "center";
  applySilence.style.justifyContent = "center";
  applySilence.style.borderRadius = "8px";
  applySilence.style.backgroundColor = "#555555";
  applySilence.style.opacity = "0.55";
  applySilence.style.cursor = "default";
  silenceBody.appendChild(applySilence);

  const silenceStatus = makeElement(
    "div", "Selecciona uno o más clips para analizar."
  );
  silenceStatus.style.padding = "8px";
  silenceStatus.style.backgroundColor = "#181818";
  silenceStatus.style.whiteSpace = "pre-wrap";
  silenceStatus.style.fontSize = "10px";
  silenceBody.appendChild(silenceStatus);
  updateSilenceCollapsed();

  // Copy Paste evita el paso de guardar una imagen manualmente. El motor local
  // recibe únicamente el bitmap que el usuario ya copió y lo deja en una
  // caché privada antes de importarlo en la secuencia activa.
  const copyPastePanel = makeElement("div");
  copyPastePanel.style.display = "flex";
  copyPastePanel.style.flexDirection = "column";
  copyPastePanel.style.gap = "8px";
  copyPastePanel.style.marginTop = "4px";
  panel.appendChild(copyPastePanel);
  let copyPasteCollapsed = true;
  try {
    copyPasteCollapsed = window.localStorage.getItem("gckCopyPasteCollapsed") !== "false";
  } catch (_) {
    // El panel comienza plegado si el almacenamiento no está disponible.
  }
  const copyPasteHeading = makeElement("div");
  copyPasteHeading.style.fontWeight = "bold";
  copyPasteHeading.style.padding = "8px";
  copyPasteHeading.style.backgroundColor = "#20252b";
  copyPasteHeading.style.border = "1px solid #3b4652";
  copyPasteHeading.style.borderRadius = "6px";
  copyPasteHeading.style.cursor = "pointer";
  copyPasteHeading.style.userSelect = "none";
  copyPastePanel.appendChild(copyPasteHeading);
  const copyPasteBody = makeElement("div");
  copyPasteBody.style.flexDirection = "column";
  copyPasteBody.style.gap = "8px";
  copyPastePanel.appendChild(copyPasteBody);
  const copyPasteHelp = makeElement(
    "div",
    "Copia una imagen desde el navegador o tu PC y pégala justo donde esté el indicador. Se usará la pista de video libre más baja."
  );
  copyPasteHelp.style.fontSize = "10px";
  copyPasteHelp.style.lineHeight = "1.35";
  copyPasteHelp.style.color = "#c7cdd4";
  copyPasteBody.appendChild(copyPasteHelp);
  const pasteImage = makeElement("div", "Pegar imagen");
  pasteImage.setAttribute("role", "button");
  pasteImage.setAttribute("tabindex", "0");
  pasteImage.style.height = "36px";
  pasteImage.style.display = "flex";
  pasteImage.style.alignItems = "center";
  pasteImage.style.justifyContent = "center";
  pasteImage.style.borderRadius = "8px";
  pasteImage.style.fontWeight = "600";
  pasteImage.style.color = "#ffffff";
  pasteImage.style.backgroundColor = "#1473e6";
  pasteImage.style.cursor = "pointer";
  pasteImage.style.userSelect = "none";
  copyPasteBody.appendChild(pasteImage);
  const copyPasteStatus = makeElement("div", "Copia una imagen y presiona Pegar.");
  copyPasteStatus.style.padding = "8px";
  copyPasteStatus.style.backgroundColor = "#181818";
  copyPasteStatus.style.fontSize = "10px";
  copyPasteStatus.style.lineHeight = "1.35";
  copyPasteStatus.style.whiteSpace = "pre-wrap";
  copyPasteBody.appendChild(copyPasteStatus);
  const updateCopyPasteCollapsed = () => {
    copyPasteHeading.textContent = `${copyPasteCollapsed ? "▶" : "▼"} Copy Paste`;
    copyPasteBody.style.display = copyPasteCollapsed ? "none" : "flex";
  };
  copyPasteHeading.addEventListener("click", () => {
    copyPasteCollapsed = !copyPasteCollapsed;
    updateCopyPasteCollapsed();
    try { window.localStorage.setItem("gckCopyPasteCollapsed", String(copyPasteCollapsed)); } catch (_) { /* session only */ }
  });
  updateCopyPasteCollapsed();

  const findImportedClipboardItem = async (folder, nativePath) => {
    const items = await folder.getItems();
    for (const item of items) {
      try {
        const clip = ppro.ClipProjectItem.cast(item);
        const mediaPath = await clip.getMediaFilePath();
        if (String(mediaPath).toLowerCase() === String(nativePath).toLowerCase()) return item;
      } catch (_) {
        try {
          const subfolder = ppro.FolderItem.cast(item);
          const found = await findImportedClipboardItem(subfolder, nativePath);
          if (found) return found;
        } catch (_) {
          // No es un clip ni una carpeta que Premiere permita recorrer.
        }
      }
    }
    return null;
  };
  const setPasteBusy = (busy, label) => {
    pasteImage.textContent = label;
    pasteImage.style.backgroundColor = busy ? "#555555" : "#1473e6";
    pasteImage.style.cursor = busy ? "default" : "pointer";
    pasteImage.style.opacity = busy ? "0.7" : "1";
    pasteImage.dataset.busy = busy ? "true" : "false";
  };
  const pasteClipboardImage = async () => {
    const response = await fetch(`${SERVICE_URL}/v1/clipboard/image`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.mediaPath) {
      throw new Error(payload.detail || "No se pudo leer una imagen del portapapeles.");
    }
    const mediaPath = String(payload.mediaPath);
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("Abre un proyecto de Premiere antes de pegar una imagen.");
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("Abre una secuencia y coloca el indicador donde quieras pegar la imagen.");
    const insertionBin = await project.getInsertionBin();
    const targetBin = ppro.FolderItem.cast(insertionBin);
    const imported = await project.importFiles([mediaPath], true, targetBin, false);
    if (!imported) throw new Error("Premiere no pudo importar la imagen copiada.");
    const projectItem = await findImportedClipboardItem(targetBin, mediaPath);
    if (!projectItem) {
      throw new Error("Premiere importó la imagen, pero aún no la preparó para colocarla. Presiona Pegar otra vez.");
    }
    const marker = await sequence.getPlayerPosition();
    const videoTrackIndex = await findLowestAvailableTrack(sequence, "video", marker);
    const editor = ppro.SequenceEditor.getEditor(sequence);
    let inserted = false;
    project.lockedAccess(() => {
      inserted = project.executeTransaction((compoundAction) => {
        // Overwrite en una pista libre no altera ni corta el montaje existente.
        compoundAction.addAction(editor.createOverwriteProjectItemAction(
          projectItem, marker, videoTrackIndex, -1
        ));
      }, "Gota Creator Kit: pegar imagen desde portapapeles");
    });
    if (!inserted) throw new Error("Premiere no pudo colocar la imagen en una pista libre.");
    return { sequence, filename: String(payload.filename || "imagen copiada") };
  };
  pasteImage.addEventListener("click", async () => {
    if (pasteImage.dataset.busy === "true") return;
    setPasteBusy(true, "Pegando imagen…");
    copyPasteStatus.textContent = "Leyendo la imagen copiada y colocándola en la secuencia…";
    try {
      const result = await pasteClipboardImage();
      copyPasteStatus.textContent = `${result.filename} se colocó en ${result.sequence.name}, en una pista de video libre.`;
    } catch (error) {
      copyPasteStatus.textContent = `No se pudo pegar: ${error.message || String(error)}`;
    } finally {
      setPasteBusy(false, "Pegar imagen");
    }
  });

  const libraryShortcut = makeElement(
    "div", "📁 Biblioteca Gota ☔ — ábrela desde Ventana > UXP Plugins para explorar y previsualizar recursos."
  );
  libraryShortcut.style.padding = "8px";
  libraryShortcut.style.backgroundColor = "#20252b";
  libraryShortcut.style.border = "1px solid #3b4652";
  libraryShortcut.style.borderRadius = "6px";
  libraryShortcut.style.fontSize = "10px";
  panel.appendChild(libraryShortcut);

  // Biblioteca local: guarda referencias persistentes a varias carpetas que el
  // usuario elige explícitamente. Se exploran bajo demanda, sin imponer límites.
  const libraryPanel = makeElement("div");
  libraryPanel.style.display = "none";
  libraryPanel.style.flexDirection = "column";
  libraryPanel.style.gap = "8px";
  libraryPanel.style.marginTop = "4px";
  panel.appendChild(libraryPanel);

  let libraryCollapsed = true;
  try {
    libraryCollapsed =
      window.localStorage.getItem("gckLibraryCollapsed") !== "false";
  } catch (_) {
    // La biblioteca inicia plegada si no hay almacenamiento disponible.
  }
  const libraryHeading = makeElement("div");
  libraryHeading.style.fontWeight = "bold";
  libraryHeading.style.padding = "8px";
  libraryHeading.style.backgroundColor = "#20252b";
  libraryHeading.style.border = "1px solid #3b4652";
  libraryHeading.style.borderRadius = "6px";
  libraryHeading.style.cursor = "pointer";
  libraryHeading.style.userSelect = "none";
  libraryPanel.appendChild(libraryHeading);

  const libraryBody = makeElement("div");
  libraryBody.style.display = "flex";
  libraryBody.style.flexDirection = "column";
  libraryBody.style.gap = "8px";
  libraryPanel.appendChild(libraryBody);

  const libraryHelp = makeElement(
    "div",
    "Añade todas las carpetas raíz que quieras. Tus archivos nunca se copian ni se suben: solo se muestran desde tu PC."
  );
  libraryHelp.style.fontSize = "10px";
  libraryHelp.style.color = "#b8b8b8";
  libraryBody.appendChild(libraryHelp);

  const libraryActions = makeElement("div");
  libraryActions.style.display = "flex";
  libraryActions.style.gap = "7px";
  libraryBody.appendChild(libraryActions);
  const addLibraryFolder = makeElement("div", "+ Añadir carpeta");
  styleAccountButton(addLibraryFolder, "#1473e6");
  addLibraryFolder.style.flex = "1";
  libraryActions.appendChild(addLibraryFolder);
  const refreshLibrary = makeElement("div", "Actualizar");
  styleAccountButton(refreshLibrary, "#3d4650");
  refreshLibrary.style.flex = "0 0 82px";
  libraryActions.appendChild(refreshLibrary);

  const libraryStatus = makeElement("div", "Aún no hay carpetas enlazadas.");
  libraryStatus.style.padding = "7px";
  libraryStatus.style.backgroundColor = "#181818";
  libraryStatus.style.fontSize = "10px";
  libraryStatus.style.whiteSpace = "pre-wrap";
  libraryBody.appendChild(libraryStatus);

  const libraryTree = makeElement("div");
  libraryTree.style.maxHeight = "250px";
  libraryTree.style.overflowY = "auto";
  libraryTree.style.backgroundColor = "#171a1e";
  libraryTree.style.border = "1px solid #3b4652";
  libraryTree.style.borderRadius = "6px";
  libraryBody.appendChild(libraryTree);

  const libraryContents = makeElement("div");
  libraryContents.style.display = "flex";
  libraryContents.style.flexDirection = "column";
  libraryContents.style.gap = "6px";
  libraryContents.style.maxHeight = "300px";
  libraryContents.style.overflowY = "auto";
  libraryContents.style.backgroundColor = "#181818";
  libraryContents.style.border = "1px solid #3b4652";
  libraryContents.style.borderRadius = "6px";
  libraryContents.style.padding = "7px";
  libraryBody.appendChild(libraryContents);

  const libraryRootsKey = "gckLocalLibraryRoots";
  let libraryRoots = [];
  let libraryEntries = new Map();
  let activeLibraryKey = "";
  try {
    const saved = JSON.parse(window.localStorage.getItem(libraryRootsKey) || "[]");
    libraryRoots = Array.isArray(saved) ? saved : [];
  } catch (_) {
    libraryRoots = [];
  }
  const saveLibraryRoots = () => {
    try {
      window.localStorage.setItem(libraryRootsKey, JSON.stringify(libraryRoots));
    } catch (_) {
      libraryStatus.textContent = "La biblioteca funcionará en esta sesión, pero no se pudo guardar la lista de carpetas.";
    }
  };
  const clearElement = (element) => {
    while (element.firstChild) element.removeChild(element.firstChild);
  };
  const folderLabel = (entry) => String(entry && entry.name ? entry.name : "Carpeta sin nombre");
  const makeLibraryRow = (text, depth = 0) => {
    const row = makeElement("div", text);
    row.style.padding = "6px 7px";
    row.style.paddingLeft = `${7 + depth * 15}px`;
    row.style.borderBottom = "1px solid #2d343b";
    row.style.fontSize = "11px";
    row.style.cursor = "pointer";
    row.style.whiteSpace = "nowrap";
    row.style.overflow = "hidden";
    row.style.textOverflow = "ellipsis";
    return row;
  };
  const renderLibraryContents = async (entry, key) => {
    activeLibraryKey = key;
    clearElement(libraryContents);
    const title = makeElement("div", `Contenido: ${folderLabel(entry)}`);
    title.style.fontWeight = "bold";
    libraryContents.appendChild(title);
    try {
      const entries = await entry.getEntries();
      const folders = entries.filter((item) => item.isFolder)
        .sort((a, b) => folderLabel(a).localeCompare(folderLabel(b)));
      const files = entries.filter((item) => item.isFile)
        .sort((a, b) => folderLabel(a).localeCompare(folderLabel(b)));
      const summary = makeElement(
        "div", `${folders.length} carpetas · ${files.length} archivos`
      );
      summary.style.fontSize = "10px";
      summary.style.color = "#a8a8a8";
      libraryContents.appendChild(summary);
      if (!entries.length) {
        const empty = makeElement("div", "Esta carpeta está vacía.");
        empty.style.color = "#999999";
        empty.style.fontSize = "10px";
        libraryContents.appendChild(empty);
        return;
      }
      for (const child of folders.concat(files)) {
        const card = makeElement(
          "div", `${child.isFolder ? "📁" : "📄"} ${folderLabel(child)}`
        );
        card.style.padding = "6px";
        card.style.backgroundColor = child.isFolder ? "#20252b" : "#151515";
        card.style.borderRadius = "4px";
        card.style.fontSize = "10px";
        card.style.overflow = "hidden";
        card.style.textOverflow = "ellipsis";
        card.style.whiteSpace = "nowrap";
        if (child.isFolder) {
          card.style.cursor = "pointer";
          card.title = "Abrir esta subcarpeta";
          card.addEventListener("click", () => renderLibraryContents(child, `${key}/${folderLabel(child)}`));
        }
        libraryContents.appendChild(card);
      }
    } catch (error) {
      const message = makeElement(
        "div", "No se pudo leer esta carpeta. Comprueba que siga conectada y que Premiere tenga permiso."
      );
      message.style.color = "#ed8b8b";
      message.style.fontSize = "10px";
      libraryContents.appendChild(message);
    }
  };
  const appendFolderTree = async (entry, key, depth, container) => {
    const row = makeLibraryRow(`▸ 📁 ${folderLabel(entry)}`, depth);
    if (activeLibraryKey === key) row.style.backgroundColor = "#1b4f83";
    const children = makeElement("div");
    children.style.display = "none";
    let loaded = false;
    row.addEventListener("click", async () => {
      await renderLibraryContents(entry, key);
      if (!loaded) {
        loaded = true;
        row.textContent = `▾ 📁 ${folderLabel(entry)}`;
        try {
          const subfolders = (await entry.getEntries())
            .filter((child) => child.isFolder)
            .sort((a, b) => folderLabel(a).localeCompare(folderLabel(b)));
          for (const child of subfolders) {
            await appendFolderTree(child, `${key}/${folderLabel(child)}`, depth + 1, children);
          }
        } catch (_) {
          children.appendChild(makeLibraryRow("No se pudo leer", depth + 1));
        }
      }
      children.style.display = children.style.display === "none" ? "block" : "none";
      row.textContent = `${children.style.display === "none" ? "▸" : "▾"} 📁 ${folderLabel(entry)}`;
    });
    container.appendChild(row);
    container.appendChild(children);
  };
  const renderLibrary = async () => {
    clearElement(libraryTree);
    clearElement(libraryContents);
    libraryEntries = new Map();
    let available = 0;
    for (const root of libraryRoots) {
      try {
        const entry = await localFileSystem.getEntryForPersistentToken(root.token);
        if (!entry || !entry.isFolder) throw new Error("La carpeta ya no está disponible.");
        libraryEntries.set(root.id, entry);
        available += 1;
        const rootWrap = makeElement("div");
        rootWrap.style.display = "flex";
        rootWrap.style.alignItems = "center";
        const remove = makeElement("div", "×");
        remove.style.padding = "4px 7px";
        remove.style.color = "#ed8b8b";
        remove.style.cursor = "pointer";
        remove.title = "Quitar esta carpeta de la biblioteca";
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          libraryRoots = libraryRoots.filter((item) => item.id !== root.id);
          saveLibraryRoots();
          renderLibrary();
        });
        rootWrap.appendChild(remove);
        libraryTree.appendChild(rootWrap);
        await appendFolderTree(entry, root.id, 0, rootWrap);
      } catch (_) {
        const unavailable = makeLibraryRow(`⚠ ${root.name || "Carpeta"} — vuelve a enlazarla`, 0);
        unavailable.style.color = "#edc36f";
        libraryTree.appendChild(unavailable);
      }
    }
    libraryStatus.textContent = available
      ? `${available} carpeta${available === 1 ? "" : "s"} raíz disponible${available === 1 ? "" : "s"}.`
      : "Aún no hay carpetas enlazadas o sus permisos cambiaron.";
    if (!available) {
      libraryContents.appendChild(makeElement("div", "Añade una carpeta para ver aquí sus archivos y subcarpetas."));
    }
  };
  addLibraryFolder.addEventListener("click", async () => {
    try {
      const folder = await localFileSystem.getFolder();
      if (!folder) return;
      const token = await localFileSystem.createPersistentToken(folder);
      if (!libraryRoots.some((root) => root.token === token)) {
        libraryRoots.push({
          id: `root-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          token,
          name: folderLabel(folder)
        });
        saveLibraryRoots();
      }
      await renderLibrary();
    } catch (error) {
      libraryStatus.textContent =
        "No se pudo enlazar la carpeta. Acepta el permiso de carpeta de Premiere e inténtalo de nuevo.";
    }
  });
  refreshLibrary.addEventListener("click", () => renderLibrary());
  const updateLibraryCollapsed = () => {
    libraryHeading.textContent = `${libraryCollapsed ? "▶" : "▼"} Biblioteca local`;
    libraryBody.style.display = libraryCollapsed ? "none" : "flex";
  };
  libraryHeading.addEventListener("click", () => {
    libraryCollapsed = !libraryCollapsed;
    updateLibraryCollapsed();
    try {
      window.localStorage.setItem("gckLibraryCollapsed", String(libraryCollapsed));
    } catch (_) {
      // El plegado funciona aunque la preferencia no pueda guardarse.
    }
  });
  updateLibraryCollapsed();
  renderLibrary();

  const accountPanel = makeElement("div");
  accountPanel.style.display = "none";
  accountPanel.style.flexDirection = "column";
  accountPanel.style.gap = "8px";
  accountPanel.style.marginTop = "4px";
  panel.appendChild(accountPanel);

  let accountCollapsed = true;
  try {
    accountCollapsed =
      window.localStorage.getItem("gckAccountCollapsed") !== "false";
  } catch (_) {
    // El panel de cuenta comienza plegado.
  }
  const accountHeading = makeElement("div");
  accountHeading.style.fontWeight = "bold";
  accountHeading.style.padding = "8px";
  accountHeading.style.backgroundColor = "#20252b";
  accountHeading.style.border = "1px solid #3b4652";
  accountHeading.style.borderRadius = "6px";
  accountHeading.style.cursor = "pointer";
  accountHeading.style.userSelect = "none";
  accountPanel.appendChild(accountHeading);

  const accountBody = makeElement("div");
  accountBody.style.flexDirection = "column";
  accountBody.style.gap = "8px";
  accountPanel.appendChild(accountBody);
  const updateAccountCollapsed = () => {
    accountHeading.textContent =
      `${accountCollapsed ? "\u25b6" : "\u25bc"} Cuenta y licencia`;
    accountBody.style.display = accountCollapsed ? "none" : "flex";
  };
  accountHeading.addEventListener("click", () => {
    accountCollapsed = !accountCollapsed;
    updateAccountCollapsed();
    try {
      window.localStorage.setItem(
        "gckAccountCollapsed", String(accountCollapsed)
      );
    } catch (_) {
      // El plegado sigue funcionando durante esta sesion.
    }
  });

  const licenseBadge = makeElement("div", "Modo de prueba - Sin iniciar sesion");
  licenseBadge.style.padding = "9px";
  licenseBadge.style.backgroundColor = "#20252b";
  licenseBadge.style.border = "1px solid #3b4652";
  licenseBadge.style.borderRadius = "6px";
  licenseBadge.style.whiteSpace = "pre-wrap";
  accountBody.appendChild(licenseBadge);

  const emailInput = makeElement("input");
  emailInput.type = "email";
  emailInput.placeholder = "Correo";
  emailInput.autocomplete = "email";
  accountBody.appendChild(emailInput);

  const passwordInput = makeElement("input");
  passwordInput.type = "password";
  passwordInput.placeholder = "Contrasena (minimo 8 caracteres)";
  passwordInput.autocomplete = "current-password";
  accountBody.appendChild(passwordInput);

  const accountActions = makeElement("div");
  accountActions.style.display = "flex";
  accountActions.style.gap = "7px";
  accountBody.appendChild(accountActions);

  function styleAccountButton(button, color) {
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    button.style.flex = "1";
    button.style.minHeight = "32px";
    button.style.display = "flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.style.borderRadius = "7px";
    button.style.backgroundColor = color;
    button.style.cursor = "pointer";
    button.style.userSelect = "none";
  }

  const loginButton = makeElement("div", "Iniciar sesion");
  styleAccountButton(loginButton, "#1473e6");
  accountActions.appendChild(loginButton);
  const registerButton = makeElement("div", "Crear cuenta");
  styleAccountButton(registerButton, "#3d4650");
  accountActions.appendChild(registerButton);

  const giftRow = makeElement("div");
  giftRow.style.display = "none";
  giftRow.style.gap = "7px";
  accountBody.appendChild(giftRow);
  const giftInput = makeElement("input");
  giftInput.placeholder = "Codigo de regalo";
  giftInput.style.flex = "1";
  giftInput.style.minWidth = "0";
  giftRow.appendChild(giftInput);
  const giftButton = makeElement("div", "Canjear");
  styleAccountButton(giftButton, "#7b5b17");
  giftButton.style.flex = "0 0 82px";
  giftRow.appendChild(giftButton);

  const subscribeButton = makeElement("div", "Comprar licencia");
  styleAccountButton(subscribeButton, "#20a464");
  subscribeButton.style.display = "none";
  accountBody.appendChild(subscribeButton);

  const logoutButton = makeElement("div", "Cerrar sesion");
  styleAccountButton(logoutButton, "#3d4650");
  logoutButton.style.display = "none";
  accountBody.appendChild(logoutButton);

  const accountMessage = makeElement(
    "div",
    "Prueba sin cargos. Codigos: GOTA-PRUEBA-1-MES, " +
    "GOTA-PRUEBA-3-MESES o GOTA-PRUEBA-1-ANO."
  );
  accountMessage.style.padding = "8px";
  accountMessage.style.backgroundColor = "#181818";
  accountMessage.style.color = "#b8b8b8";
  accountMessage.style.fontSize = "10px";
  accountMessage.style.whiteSpace = "pre-wrap";
  accountBody.appendChild(accountMessage);
  updateAccountCollapsed();

  let licenseToken = "";
  let accountBusy = false;
  let deviceId = "";
  const stableDeviceFallback = () => {
    try {
      const host = typeof os.hostname === "function" ? os.hostname() : "premiere";
      const raw = `${os.platform()}-${host}`.toLowerCase();
      return `gck-${raw.replace(/[^a-z0-9]+/g, "-").slice(0, 120)}`;
    } catch (_) {
      return "gck-premiere-device";
    }
  };
  try {
    licenseToken = window.localStorage.getItem("gckLicenseToken") || "";
    deviceId = window.localStorage.getItem("gckDeviceId") || "";
    if (!deviceId) {
      deviceId = stableDeviceFallback();
      window.localStorage.setItem("gckDeviceId", deviceId);
    }
  } catch (_) {
    // Algunas instalaciones UXP no persisten localStorage. El respaldo sigue
    // siendo estable para no consumir un equipo nuevo en cada apertura.
    deviceId = stableDeviceFallback();
  }

  function setAccountBusy(value) {
    accountBusy = value;
    [loginButton, registerButton, giftButton, subscribeButton, logoutButton]
      .forEach((button) => {
        button.style.opacity = value ? "0.55" : "1";
        button.style.cursor = value ? "default" : "pointer";
      });
  }

  function formatLicenseDate(value) {
    if (!value) return "Sin vencimiento";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : date.toLocaleDateString();
  }

  function formatLicenseRemaining(value) {
    const totalDays = Math.max(0, Math.floor(Number(value) || 0));
    const years = Math.floor(totalDays / 365);
    const afterYears = totalDays % 365;
    const months = Math.floor(afterYears / 30);
    const days = afterYears % 30;
    const parts = [];
    if (years) parts.push(`${years} ${years === 1 ? "año" : "años"}`);
    if (months) parts.push(`${months} ${months === 1 ? "mes" : "meses"}`);
    if (days || parts.length === 0) {
      parts.push(`${days} ${days === 1 ? "día" : "días"}`);
    }
    return parts.join(", ");
  }

  function readableLicenseError(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value.map((item) =>
        readableLicenseError(item && (item.msg || item.message || item))
      ).join("\n");
    }
    if (value && typeof value === "object") {
      if (value.detail) return readableLicenseError(value.detail);
      if (value.message) return readableLicenseError(value.message);
      try {
        return JSON.stringify(value);
      } catch (_) {
        return "No se pudo validar la licencia.";
      }
    }
    return value ? String(value) : "No se pudo validar la licencia.";
  }

  function renderAccount(account) {
    const signedIn = Boolean(account && account.authenticated);
    emailInput.style.display = signedIn ? "none" : "block";
    passwordInput.style.display = signedIn ? "none" : "block";
    accountActions.style.display = signedIn ? "none" : "flex";
    giftRow.style.display = signedIn ? "flex" : "none";
    // Debe estar disponible también antes de registrar una licencia.
    subscribeButton.style.display = "flex";
    logoutButton.style.display = signedIn ? "flex" : "none";
    if (!signedIn) {
      licenseBadge.textContent = "Modo de prueba - Sin iniciar sesion";
      return;
    }
    licenseBadge.textContent =
      `Modo de prueba - ${account.plan}\n` +
      `${account.email}\n` +
      `Acceso hasta: ${formatLicenseDate(account.accessUntil)} ` +
      `(${account.daysRemaining} dias)\n` +
      `Equipos: ${account.deviceCount}/${account.maxDevices}`;
  }

  async function accountRequest(path, options = {}) {
    const headers = {
      "content-type": "application/json",
      ...(options.headers || {})
    };
    if (licenseToken) headers.authorization = `Bearer ${licenseToken}`;
    const response = await fetch(`${SERVICE_URL}${path}`, {
      ...options,
      headers
    });
    if (!response.ok) {
      let message = `Error ${response.status}`;
      try {
        const body = await response.json();
        message = body.detail || message;
      } catch (_) {
        // Conserva el mensaje HTTP.
      }
      throw new Error(message);
    }
    return response.status === 204 ? null : response.json();
  }

  async function submitAccount(kind) {
    if (accountBusy) return;
    if (!emailInput.value || passwordInput.value.length < 8) {
      accountMessage.textContent =
        "Escribe tu correo y una contrasena de al menos 8 caracteres.";
      return;
    }
    setAccountBusy(true);
    accountMessage.textContent =
      kind === "register" ? "Creando cuenta de prueba..." : "Iniciando sesion...";
    try {
      const result = await accountRequest(`/v3/account/${kind}`, {
        method: "POST",
        body: JSON.stringify({
          email: emailInput.value,
          password: passwordInput.value,
          deviceId,
          deviceName: `${os.platform()} - Premiere`
        })
      });
      licenseToken = result.token;
      try {
        window.localStorage.setItem("gckLicenseToken", licenseToken);
      } catch (_) {
        // La sesion seguira activa mientras el panel permanezca abierto.
      }
      passwordInput.value = "";
      renderAccount(result.account);
      accountMessage.textContent =
        kind === "register"
          ? "Cuenta creada. Incluye 7 dias de prueba."
          : "Sesion iniciada correctamente.";
    } catch (error) {
      accountMessage.textContent = error.message || String(error);
    } finally {
      setAccountBusy(false);
    }
  }

  loginButton.addEventListener("click", () => submitAccount("login"));
  registerButton.addEventListener("click", () => submitAccount("register"));
  giftButton.addEventListener("click", async () => {
    if (accountBusy || !licenseToken) return;
    setAccountBusy(true);
    accountMessage.textContent = "Canjeando codigo...";
    try {
      const account = await accountRequest("/v3/gifts/redeem", {
        method: "POST",
        body: JSON.stringify({ code: giftInput.value })
      });
      giftInput.value = "";
      renderAccount(account);
      accountMessage.textContent = "Codigo aplicado correctamente.";
    } catch (error) {
      accountMessage.textContent = error.message || String(error);
    } finally {
      setAccountBusy(false);
    }
  });
  subscribeButton.addEventListener("click", async () => {
    if (accountBusy) return;
    try {
      const result = await shell.openExternal(
        "https://ig.me/m/jahir.emm",
        "Abrir Instagram para comprar una licencia de Gota Creator Kit."
      );
      if (result) throw new Error(String(result));
      accountMessage.textContent =
        "Instagram se abrió. Envíame un mensaje para comprar tu licencia.";
    } catch (error) {
      accountMessage.textContent =
        "No se pudo abrir Instagram: " + (error.message || String(error));
    }
  });
  logoutButton.addEventListener("click", async () => {
    if (accountBusy) return;
    setAccountBusy(true);
    try {
      if (licenseToken) {
        await accountRequest("/v3/account/logout", {
          method: "POST",
          body: "{}"
        });
      }
    } catch (_) {
      // Cerrar localmente sigue siendo seguro si el motor no esta disponible.
    }
    licenseToken = "";
    try {
      window.localStorage.removeItem("gckLicenseToken");
    } catch (_) {
      // No hay almacenamiento persistente.
    }
    renderAccount(null);
    accountMessage.textContent = "Sesion cerrada.";
    setAccountBusy(false);
  });

  if (licenseToken) {
    setTimeout(async () => {
      try {
        renderAccount(await accountRequest("/v3/license/status"));
      } catch (_) {
        licenseToken = "";
        try {
          window.localStorage.removeItem("gckLicenseToken");
        } catch (_) {
          // No hay almacenamiento persistente.
        }
        renderAccount(null);
        accountMessage.textContent =
          "La sesion anterior vencio. Inicia sesion nuevamente.";
      }
    }, 800);
  } else {
    renderAccount(null);
  }

  const codeLicensePanel = makeElement("div");
  codeLicensePanel.style.display = "flex";
  codeLicensePanel.style.flexDirection = "column";
  codeLicensePanel.style.gap = "8px";
  panel.appendChild(codeLicensePanel);

  let codeLicenseCollapsed = false;
  try {
    codeLicenseCollapsed =
      window.localStorage.getItem("gckCodeLicenseCollapsed") === "true";
  } catch (_) {
    // La activacion comienza visible.
  }
  const codeLicenseHeading = makeElement("div");
  codeLicenseHeading.style.fontWeight = "bold";
  codeLicenseHeading.style.padding = "8px";
  codeLicenseHeading.style.backgroundColor = "#20252b";
  codeLicenseHeading.style.border = "1px solid #3b4652";
  codeLicenseHeading.style.borderRadius = "6px";
  codeLicenseHeading.style.cursor = "pointer";
  codeLicenseHeading.style.userSelect = "none";
  codeLicensePanel.appendChild(codeLicenseHeading);

  const codeLicenseBody = makeElement("div");
  codeLicenseBody.style.display = "flex";
  codeLicenseBody.style.flexDirection = "column";
  codeLicenseBody.style.gap = "8px";
  codeLicensePanel.appendChild(codeLicenseBody);

  const graceNotice = makeElement("div");
  graceNotice.style.display = "none";
  graceNotice.style.padding = "11px";
  graceNotice.style.backgroundColor = "#5c4515";
  graceNotice.style.border = "1px solid #c99a2e";
  graceNotice.style.borderRadius = "7px";
  graceNotice.style.color = "#fff3c4";
  graceNotice.style.whiteSpace = "pre-wrap";
  codeLicenseBody.appendChild(graceNotice);

  const codeLicenseStatus = makeElement(
    "div", "Sin licencia registrada."
  );
  codeLicenseStatus.style.padding = "9px";
  codeLicenseStatus.style.backgroundColor = "#20252b";
  codeLicenseStatus.style.border = "1px solid #3b4652";
  codeLicenseStatus.style.borderRadius = "6px";
  codeLicenseStatus.style.whiteSpace = "pre-wrap";
  codeLicenseBody.appendChild(codeLicenseStatus);

  const deviceInfo = makeElement(
    "div", `ID de esta instalacion:\n${deviceId}`
  );
  deviceInfo.style.padding = "7px";
  deviceInfo.style.backgroundColor = "#181818";
  deviceInfo.style.color = "#b8b8b8";
  deviceInfo.style.fontSize = "9px";
  deviceInfo.style.whiteSpace = "pre-wrap";
  deviceInfo.style.wordBreak = "break-all";
  codeLicenseBody.appendChild(deviceInfo);

  const signedCodeInput = makeElement("textarea");
  signedCodeInput.placeholder = "Escribe tu clave, por ejemplo GOTA3MESES";
  signedCodeInput.rows = 2;
  signedCodeInput.style.width = "100%";
  signedCodeInput.style.boxSizing = "border-box";
  signedCodeInput.style.resize = "vertical";
  codeLicenseBody.appendChild(signedCodeInput);

  const activateSignedCode = makeElement("div", "Activar licencia");
  styleAccountButton(activateSignedCode, "#20a464");
  codeLicenseBody.appendChild(activateSignedCode);

  const buyLicenseButton = makeElement("div", "Comprar licencia");
  styleAccountButton(buyLicenseButton, "#1976d2");
  buyLicenseButton.title = "Escribir a @Jahir.Emm en Instagram";
  codeLicenseBody.appendChild(buyLicenseButton);

  const removeSignedCode = makeElement("div", "Quitar licencia de este equipo");
  styleAccountButton(removeSignedCode, "#3d4650");
  removeSignedCode.style.display = "none";
  codeLicenseBody.appendChild(removeSignedCode);

  const renderSignedLicense = (license) => {
    const active = Boolean(license && license.active);
    const grace = Boolean(license && license.grace);
    const registered = active && !grace;
    signedCodeInput.style.display = registered ? "none" : "block";
    activateSignedCode.style.display = registered ? "none" : "flex";
    removeSignedCode.style.display = registered ? "flex" : "none";
    graceNotice.style.display = grace ? "block" : "none";
    if (grace) {
      graceNotice.textContent =
        `Bienvenido a Gota Creator Kit ☔\n` +
        `Tienes una prorroga gratuita de 7 dias para conseguir tu licencia.\n` +
        `Tiempo restante: ${formatLicenseRemaining(license.daysRemaining)}.`;
    }
    if (!active) {
      codeLicenseStatus.textContent = "Sin licencia registrada.";
      return;
    }
    if (grace) {
      codeLicenseStatus.textContent =
        `Prorroga inicial activa.\n` +
        `Vence: ${formatLicenseDate(license.expiresAt)}`;
      return;
    }
    codeLicenseStatus.textContent =
      `Licencia activa${license.label ? ` - ${license.label}` : ""}\n` +
      (license.perpetual
        ? "Duracion: Indefinida\n"
        : `Vence: ${formatLicenseDate(license.expiresAt)}\n` +
          `Tiempo restante: ${formatLicenseRemaining(license.daysRemaining)}\n`) +
      (license.deviceBound
        ? "Protegida para este equipo."
        : "Codigo sin bloqueo de equipo.");
  };

  const updateCodeLicenseCollapsed = () => {
    codeLicenseHeading.textContent =
      `${codeLicenseCollapsed ? "\u25b6" : "\u25bc"} Licencia por codigo`;
    codeLicenseBody.style.display = codeLicenseCollapsed ? "none" : "flex";
  };
  codeLicenseHeading.addEventListener("click", () => {
    codeLicenseCollapsed = !codeLicenseCollapsed;
    updateCodeLicenseCollapsed();
    try {
      window.localStorage.setItem(
        "gckCodeLicenseCollapsed", String(codeLicenseCollapsed)
      );
    } catch (_) {
      // El plegado sigue funcionando durante esta sesion.
    }
  });
  title.style.cursor = "pointer";
  title.title = "Abrir activacion de licencia";
  title.addEventListener("click", () => {
    codeLicenseCollapsed = false;
    updateCodeLicenseCollapsed();
    codeLicensePanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  updateCodeLicenseCollapsed();

  async function signedLicenseRequest(path, method, body) {
    // El supervisor arranca el motor unos instantes después de Premiere. Al
    // reabrir el panel no confundimos ese arranque con una licencia perdida.
    let response;
    let lastError;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        response = await fetch(`${SERVICE_URL}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined
        });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!response) {
      throw new Error("El motor local está iniciando. Espera unos segundos y vuelve a intentarlo.");
    }
    if (!response.ok) {
      let message = `Error ${response.status}`;
      try {
        const data = await response.json();
        message = readableLicenseError(data.detail || data.message || message);
      } catch (_) {
        // Conserva el mensaje HTTP.
      }
      if (message === "Not Found") {
        message = "Sin licencia registrada.";
      }
      throw new Error(message);
    }
    return response.status === 204 ? null : response.json();
  }

  async function requireSignedLicense() {
    const license = await signedLicenseRequest(
      "/v4/license/status", "POST", { deviceId }
    );
    renderSignedLicense(license);
    if (!license.active) {
      codeLicenseCollapsed = false;
      updateCodeLicenseCollapsed();
      throw new Error(
        "Activa una licencia vigente en el panel Licencia por codigo."
      );
    }
    return license;
  }

  activateSignedCode.addEventListener("click", async () => {
    if (!signedCodeInput.value.trim()) {
      codeLicenseStatus.textContent = "Pega un codigo antes de activarlo.";
      return;
    }
    activateSignedCode.style.opacity = "0.55";
    codeLicenseStatus.textContent = "Validando clave y vencimiento...";
    try {
      const license = await signedLicenseRequest(
        "/v4/license/activate",
        "POST",
        { code: signedCodeInput.value.trim(), deviceId }
      );
      signedCodeInput.value = "";
      renderSignedLicense(license);
    } catch (error) {
      codeLicenseStatus.textContent = error.message || String(error);
    } finally {
      activateSignedCode.style.opacity = "1";
    }
  });
  buyLicenseButton.addEventListener("click", async () => {
    try {
      const result = await shell.openExternal("https://ig.me/m/jahir.emm");
      if (result) throw new Error(String(result));
      codeLicenseStatus.textContent =
        "Instagram se abrió. Envíame un mensaje para comprar tu licencia.";
    } catch (error) {
      codeLicenseStatus.textContent =
        "No se pudo abrir Instagram: " + (error.message || String(error));
    }
  });
  removeSignedCode.addEventListener("click", async () => {
    try {
      await signedLicenseRequest(
        `/v4/license?device_id=${encodeURIComponent(deviceId)}`, "DELETE"
      );
      renderSignedLicense(null);
    } catch (error) {
      codeLicenseStatus.textContent = error.message || String(error);
    }
  });

  setTimeout(async () => {
    try {
      const license = await signedLicenseRequest(
        "/v4/license/status", "POST", { deviceId }
      );
      renderSignedLicense(license);
    } catch (error) {
      codeLicenseStatus.textContent = error.message || String(error);
    }
  }, 1800);

  const updateButton = makeElement("div", "Buscar actualizaciones");
  updateButton.setAttribute("role", "button");
  updateButton.setAttribute("tabindex", "0");
  updateButton.style.height = "30px";
  updateButton.style.display = "flex";
  updateButton.style.alignItems = "center";
  updateButton.style.justifyContent = "center";
  updateButton.style.marginTop = "8px";
  updateButton.style.border = "1px solid #555555";
  updateButton.style.borderRadius = "7px";
  updateButton.style.backgroundColor = "#292929";
  updateButton.style.color = "#d5d5d5";
  updateButton.style.cursor = "pointer";
  updateButton.style.userSelect = "none";
  panel.appendChild(updateButton);

  const updateStatus = makeElement("div");
  updateStatus.style.display = "none";
  updateStatus.style.padding = "7px 8px";
  updateStatus.style.backgroundColor = "#20252b";
  updateStatus.style.borderRadius = "6px";
  updateStatus.style.color = "#c7c7c7";
  updateStatus.style.fontSize = "10px";
  updateStatus.style.whiteSpace = "pre-wrap";
  updateStatus.style.textAlign = "center";
  panel.appendChild(updateStatus);

  const updateNotice = makeElement("div");
  updateNotice.style.display = "none";
  updateNotice.style.padding = "8px";
  updateNotice.style.marginTop = "5px";
  updateNotice.style.backgroundColor = "#164f2f";
  updateNotice.style.border = "1px solid #20a464";
  updateNotice.style.borderRadius = "6px";
  updateNotice.style.color = "#ffffff";
  updateNotice.style.fontSize = "10px";
  updateNotice.style.textAlign = "center";
  panel.appendChild(updateNotice);

  const footer = makeElement("div", "¡Entérate de las novedades!");
  footer.style.marginTop = "8px";
  footer.style.paddingTop = "10px";
  footer.style.borderTop = "1px solid #444444";
  footer.style.textAlign = "center";
  footer.style.color = "#a8a8a8";
  footer.style.fontSize = "11px";
  panel.appendChild(footer);

  const instagram = makeElement("div", "Instagram: @Jahir.Emm");
  instagram.style.textAlign = "center";
  instagram.style.color = "#a8a8a8";
  instagram.style.fontSize = "11px";
  instagram.style.marginTop = "4px";
  instagram.style.cursor = "pointer";
  instagram.style.textDecoration = "underline";
  instagram.setAttribute("role", "link");
  instagram.setAttribute("tabindex", "0");
  panel.appendChild(instagram);

  const version = makeElement("div", `Versión ${CURRENT_VERSION}`);
  version.textContent = `Versi\u00f3n ${CURRENT_VERSION}`;
  version.style.textAlign = "center";
  version.style.color = "#777777";
  version.style.fontSize = "10px";
  version.style.marginTop = "4px";
  version.style.marginBottom = "2px";
  panel.appendChild(version);

  let busy = false;
  let lastProject = null;
  let lastSequence = null;
  let lastAnalyses = [];
  let currentJobId = null;
  let cancelRequested = false;
let silenceBusy = false;
let silenceAnalyses = [];
let silenceDiagnosticLogs = [];
  let silenceProject = null;
  let silenceSequence = null;
  let availableDownloadUrl = "";
  let checkingUpdates = false;
  let updateNoticeTimer = null;

  function showUpdateNotice(message, isError = false) {
    if (updateNoticeTimer) clearTimeout(updateNoticeTimer);
    updateNotice.textContent = message;
    updateNotice.style.display = "block";
    updateNotice.style.backgroundColor = isError ? "#5a2424" : "#164f2f";
    updateNotice.style.borderColor = isError ? "#d45b5b" : "#20a464";
    updateNoticeTimer = setTimeout(() => {
      updateNotice.style.display = "none";
    }, 5000);
  }

  async function checkForUpdates(silentWhenCurrent = false) {
    if (checkingUpdates) return;
    checkingUpdates = true;
    availableDownloadUrl = "";
    updateButton.textContent = "Buscando...";
    updateButton.style.opacity = "0.65";
    updateStatus.style.display = "block";
    updateStatus.textContent = "Consultando la versión más reciente...";
    try {
      const separator = UPDATE_MANIFEST_URL.includes("?") ? "&" : "?";
      const response = await fetch(
        `${UPDATE_MANIFEST_URL}${separator}t=${Date.now()}`,
        { headers: { Accept: "application/vnd.github.raw+json" } }
      );
      if (!response.ok) {
        throw new Error(`GitHub respondió ${response.status}`);
      }
      const release = JSON.parse(await response.text());
      const comparison = compareVersions(release.version, CURRENT_VERSION);
      if (comparison === null) {
        throw new Error("El archivo de actualización no tiene una versión válida");
      }
      if (comparison > 0) {
        availableDownloadUrl = String(
          // Solo Windows debe recibir el .exe. UXP puede reportar macOS con
          // nombres distintos según la versión de Premiere.
          os.platform() === "win32"
            ? (release.windowsDownloadUrl || release.downloadUrl || "")
            : (release.macDownloadUrl || release.downloadUrl || "")
        );
        updateButton.textContent = availableDownloadUrl
          ? "Descargar actualización"
          : "Actualización disponible";
        updateButton.style.backgroundColor = "#1473e6";
        updateButton.style.color = "#ffffff";
        updateStatus.textContent =
          `Nueva versión: ${release.displayVersion || release.version}` +
          (release.notes ? `\n${release.notes}` : "");
        showUpdateNotice(
          `¡Actualización disponible! ${release.displayVersion || release.version}`
        );
      } else {
        updateButton.textContent = "Buscar actualizaciones";
        updateButton.style.backgroundColor = "#292929";
        updateStatus.textContent =
          comparison === 0
            ? "Gota Creator Kit está actualizado."
            : "Esta instalación es más nueva que la versión publicada.";
        if (!silentWhenCurrent || comparison !== 0) {
          showUpdateNotice(
            comparison === 0
              ? "Ya tienes la versión más reciente."
              : "Esta instalación es más nueva que la versión publicada."
          );
        }
      }
    } catch (error) {
      updateButton.textContent = "Reintentar actualización";
      updateButton.style.backgroundColor = "#292929";
      updateStatus.textContent =
        "No se pudo consultar la actualización.\n" +
        "Revisa tu conexión a internet e inténtalo de nuevo.";
      showUpdateNotice("No se pudo buscar la actualización.", true);
    } finally {
      checkingUpdates = false;
      updateButton.style.opacity = "1";
    }
  }

  updateButton.addEventListener("click", async () => {
    if (availableDownloadUrl) {
      try {
        const result = await shell.openExternal(
          availableDownloadUrl,
          "Abrir la descarga oficial de Gota Creator Kit."
        );
        if (result) {
          updateStatus.textContent = `No se pudo abrir la descarga: ${result}`;
        }
      } catch (error) {
        updateStatus.textContent =
          `No se pudo abrir la descarga: ${error.message || String(error)}`;
      }
      return;
    }
    await checkForUpdates();
  });

  updateButton.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") updateButton.click();
  });

  setTimeout(() => {
    checkForUpdates(true);
  }, 1200);

  async function openInstagram() {
    try {
      await shell.openExternal(
        "https://www.instagram.com/jahir.emm/",
        "Abrir el Instagram oficial de Gota Creator Kit."
      );
    } catch (_) {
      showUpdateNotice("No se pudo abrir Instagram.", true);
    }
  }
  instagram.addEventListener("click", openInstagram);
  instagram.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") openInstagram();
  });

  function setSilenceBusy(isBusy) {
    silenceBusy = isBusy;
    analyzeSilence.textContent = isBusy
      ? "Analizando audio..."
      : "Analizar silencios";
    analyzeSilence.style.backgroundColor = isBusy ? "#666666" : "#1473e6";
    analyzeSilence.style.opacity = isBusy ? "0.7" : "1";
    analyzeSilence.style.cursor = isBusy ? "default" : "pointer";
  }

  function setSilenceApplyEnabled(enabled) {
    applySilence.textContent = "Aplicar resultado a la secuencia activa";
    applySilence.style.backgroundColor = enabled ? "#20a464" : "#555555";
    applySilence.style.opacity = enabled ? "1" : "0.55";
    applySilence.style.cursor = enabled ? "pointer" : "default";
  }

  analyzeSilence.addEventListener("click", async () => {
    if (silenceBusy || busy) return;
    setSilenceBusy(true);
    setSilenceApplyEnabled(false);
    try {
      await requireSignedLicense();
    } catch (error) {
      silenceStatus.textContent = error.message || String(error);
      setSilenceBusy(false);
      return;
    }
    silenceAnalyses = [];
    silenceDiagnosticLogs = [];
    silenceStatus.textContent = "Leyendo la selección de Premiere...";
    try {
      // Registra incluso los fallos que ocurren antes de que el motor pueda
      // crear el trabajo (por ejemplo, una selección inválida o un ajuste
      // cambiado). Así Natural deja una pista de diagnóstico verificable.
      const analysisDiagnosticPath = await recordSilenceOperation(
        "analysis_requested",
        {
          thresholdDb: thresholdInput.value,
          minimumSilenceSeconds: minimumSilenceInput.value,
          paddingPreset: silencePadding.value,
          paddingSeconds: silencePaddingInput.value
        }
      );
      if (analysisDiagnosticPath) silenceDiagnosticLogs.push(analysisDiagnosticPath);
      const project = await ppro.Project.getActiveProject();
      if (!project) throw new Error("No hay un proyecto activo.");
      const sequence = await project.getActiveSequence();
      if (!sequence) throw new Error("No hay una secuencia activa.");
      const clips = await collectSelectedSilenceClips(sequence);
      if (!clips.length) throw new Error("Selecciona uno o más clips de video o audio.");
      const manualThreshold = Number(thresholdInput.value);
      const manualMinimum = Number(minimumSilenceInput.value);
      const manualPadding = Number(silencePaddingInput.value);
      if (
        !Number.isFinite(manualThreshold) ||
        manualThreshold < -96 ||
        manualThreshold > 0
      ) {
        throw new Error("Escribe un nivel entre -96 y 0 dB.");
      }
      if (!Number.isFinite(manualMinimum) || manualMinimum < 0.1 || manualMinimum > 5) {
        throw new Error("Escribe una duración entre 0.10 y 5.00 segundos.");
      }
      if (!Number.isFinite(manualPadding) || manualPadding < 0 || manualPadding > 1) {
        throw new Error("Escribe una protección entre 0 y 1 segundo.");
      }

      for (let index = 0; index < clips.length; index += 1) {
        const clip = clips[index];
        silenceStatus.textContent =
          `Analizando ${index + 1}/${clips.length}: ${clip.name}`;
        const response = await fetch(`${SERVICE_URL}/v3/silence-jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mediaPath: clip.mediaPath,
            thresholdDb: manualThreshold,
            minimumSilenceSeconds: manualMinimum,
            paddingSeconds: manualPadding,
            startSeconds: clip.inPointSeconds,
            endSeconds: clip.outPointSeconds
          })
        });
        if (!response.ok) {
          throw new Error(`Motor local ${response.status}: ${await response.text()}`);
        }
        const created = await response.json();
        let job;
        const jobStartedAt = Date.now();
        do {
          await new Promise((resolve) => setTimeout(resolve, 400));
          const jobResponse = await fetch(`${SERVICE_URL}/v1/jobs/${created.jobId}`);
          if (!jobResponse.ok) {
            throw new Error("No se pudo consultar el análisis de audio.");
          }
          job = await jobResponse.json();
          const remaining = estimateRemainingSeconds(jobStartedAt, job.progress);
          silenceStatus.textContent =
            `Analizando ${index + 1}/${clips.length}: ${clip.name}\n` +
            `Progreso: ${job.progress || 0}%` +
            (remaining == null
              ? "\nCalculando tiempo restante..."
              : `\nTiempo estimado: ${formatRemainingTime(remaining)}`);
        } while (job.status === "queued" || job.status === "running");
        if (job.diagnosticLogPath) silenceDiagnosticLogs.push(job.diagnosticLogPath);
        if (job.status !== "completed") {
          throw new Error(job.error || "El análisis de silencios falló.");
        }
        silenceAnalyses.push({ clip, result: job.result });
        try {
          await fetch(`${SERVICE_URL}/v1/jobs/${created.jobId}`, {
            method: "DELETE"
          });
        } catch (_) {
          // El servicio también limpia trabajos antiguos.
        }
      }

      const silenceCount = silenceAnalyses.reduce(
        (sum, item) => sum + item.result.silenceCount, 0
      );
      const savedSeconds = silenceAnalyses.reduce(
        (sum, item) =>
          sum +
          item.result.removedDurationSeconds *
            Number(item.clip.sourceToTimelineScale || 1),
        0
      );
      const examples = silenceAnalyses.flatMap((item) =>
        item.result.silences.slice(0, 6).map((silence) => {
          const timeScale = Number(item.clip.sourceToTimelineScale || 1);
          const scaledTimelineTime =
            item.clip.startSeconds +
            (silence.startSeconds - item.clip.inPointSeconds) *
            timeScale;
          return `${formatTimecode(scaledTimelineTime)} — ` +
            `${(silence.durationSeconds * timeScale).toFixed(1)} s`;
        })
      );
      const thresholdLimited = silenceAnalyses.some(
        (item) => item.result.diagnostics?.thresholdWasLimited
      );
      const diagnosticHint = silenceDiagnosticLogs.length
        ? `\n\nRegistro de diagnóstico guardado:\n${silenceDiagnosticLogs[0]}`
        : "";
      silenceStatus.textContent =
        `Análisis listo: ${silenceCount} silencios\n` +
        `Tiempo que puede retirarse: ${formatTimecode(savedSeconds)}` +
        (thresholdLimited
          ? "\nNivel ajustado de forma conservadora para no cortar conversación normal."
          : "") +
        (examples.length
          ? `\n\nPrimeros resultados:\n${examples.join("\n")}`
          : "") + diagnosticHint;
      silenceProject = project;
      silenceSequence = sequence;
      setSilenceApplyEnabled(silenceCount > 0);
      if (silenceCount > 0) {
        applySilence.textContent =
          `Aplicar ${silenceCount} cortes y cerrar huecos`;
      }
    } catch (error) {
      const diagnosticPath = await recordSilenceOperation("analysis_panel_failed", {
        error: error.message || String(error),
        thresholdDb: thresholdInput.value,
        minimumSilenceSeconds: minimumSilenceInput.value,
        paddingPreset: silencePadding.value,
        paddingSeconds: silencePaddingInput.value
      });
      silenceStatus.textContent =
        `Error: ${error.message || String(error)}\n` +
        "Registro de diagnóstico: " +
        (diagnosticPath || silenceDiagnosticLogs[0] ||
          "vuelve a iniciar Premiere para activar el motor actualizado.");
    } finally {
      setSilenceBusy(false);
    }
  });

  applySilence.addEventListener("click", async () => {
    if (
      silenceBusy || !silenceAnalyses.length ||
      !silenceProject || !silenceSequence
    ) return;
    // El botón verde aplica directamente. La confirmación de dos clics hacía
    // parecer que el módulo fallaba, porque el primer clic no editaba nada.
    // Premiere guarda todo dentro de una operación reversible con Deshacer.
    setSilenceBusy(true);
    setSilenceApplyEnabled(false);
    silenceStatus.textContent =
      silenceMode.value === "delete"
        ? "Cerrando silencios en la secuencia activa..."
        : "Colocando silencios para revisión en la pista superior...";
    try {
      // El análisis puede durar varios minutos. Antes de editar volvemos a
      // tomar el proyecto y la secuencia actual, ya que Premiere invalida el
      // objeto anterior si el usuario hizo cualquier cambio mientras tanto.
      const activeProject = await ppro.Project.getActiveProject();
      const activeSequence = activeProject
        ? await activeProject.getActiveSequence()
        : null;
      if (!activeProject || !activeSequence) {
        throw new Error("Abre la secuencia donde analizaste los clips antes de aplicar.");
      }
      silenceProject = activeProject;
      silenceSequence = activeSequence;
      const refreshed = await refreshAnalysisLocations(
        silenceSequence, silenceAnalyses
      );
      if (refreshed) {
        silenceStatus.textContent +=
          `\nSe actualizaron ${refreshed} clips movidos en la línea de tiempo.`;
      }
      const edited = await applySilenceEdit(
        silenceProject, silenceSequence, silenceAnalyses, silenceMode.value
      );
      silenceStatus.textContent =
        `Secuencia actualizada: ${edited.sequence.name}\n` +
        (silenceMode.value === "delete"
          ? "Los fragmentos con diálogo quedaron unidos sin huecos. " +
            (edited.removalSummary.pendingCleanup
              ? "Premiere no permitió retirar un original al primer intento; el diálogo nuevo ya quedó creado. Usa Deshacer si ves un duplicado."
              : edited.removalSummary.disabled
              ? "Premiere protegió el borrado de un original; quedó desactivado para que no se duplique."
              : "Los clips originales se retiraron.") +
            " Si quieres volver atrás, usa Deshacer en Premiere."
          : "La pista superior muestra los diálogos conservados y el video " +
            "original quedó desactivado.");
    } catch (error) {
      const diagnosticPath = await recordSilenceOperation("apply_failed", {
        mode: silenceMode.value,
        error: error.message || String(error),
        analyzedClips: silenceAnalyses.map((item) => item.clip.name)
      });
      silenceStatus.textContent =
        `No se pudo aplicar: ${error.message || String(error)}\n` +
        "Revisa la secuencia y usa Deshacer si Premiere alcanzó a crear algún bloque." +
        (diagnosticPath ? `\nRegistro para diagnóstico: ${diagnosticPath}` : "");
      setSilenceApplyEnabled(true);
    } finally {
      setSilenceBusy(false);
    }
  });

  analyzeSilence.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") analyzeSilence.click();
  });
  applySilence.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") applySilence.click();
  });

  function setBusy(isBusy, canCancel = false) {
    busy = isBusy;
    analyze.setAttribute("aria-disabled", String(isBusy));
    analyze.style.backgroundColor = isBusy ? "#6b6b6b" : "#1473e6";
    analyze.style.cursor = isBusy ? "default" : "pointer";
    analyze.style.opacity = isBusy ? "0.72" : "1";
    analyze.textContent = isBusy ? "Analizando..." : "Analizar seleccion";
    cancel.style.display = isBusy && canCancel ? "flex" : "none";
  }

  function setApplyEnabled(enabled) {
    apply.setAttribute("aria-disabled", String(!enabled));
    apply.style.backgroundColor = enabled ? "#20a464" : "#555555";
    apply.style.cursor = enabled ? "pointer" : "default";
    apply.style.opacity = enabled ? "1" : "0.55";
  }

  function renderShotEditor(sequence, analyses) {
    shotEditor.innerHTML = "";
    let previewCollapsed = false;
    try {
      previewCollapsed =
        window.localStorage.getItem("autoframePreviewCollapsed") === "true";
    } catch (_) {
      // Usa el estado abierto si el almacenamiento no esta disponible.
    }
    const heading = makeElement("div");
    heading.style.fontWeight = "bold";
    heading.style.marginTop = "4px";
    heading.style.padding = "7px 8px";
    heading.style.backgroundColor = "#20252b";
    heading.style.border = "1px solid #3b4652";
    heading.style.borderRadius = "6px";
    heading.style.cursor = "pointer";
    heading.style.userSelect = "none";
    shotEditor.appendChild(heading);
    const shotList = makeElement("div");
    shotList.style.display = "flex";
    shotList.style.flexDirection = "column";
    shotList.style.gap = "8px";
    shotList.style.flexShrink = "0";
    shotEditor.appendChild(shotList);

    const updateCollapsedState = () => {
      heading.textContent =
        `${previewCollapsed ? "▶" : "▼"} Vista previa de planos`;
      shotList.style.display = previewCollapsed ? "none" : "flex";
    };
    heading.addEventListener("click", () => {
      previewCollapsed = !previewCollapsed;
      updateCollapsedState();
      try {
        window.localStorage.setItem(
          "autoframePreviewCollapsed", String(previewCollapsed)
        );
      } catch (_) {
        // El plegado sigue funcionando durante esta sesion.
      }
    });

    analyses.forEach((analysis) => {
      (analysis.result.shots || []).slice(0, 30).forEach((shot, shotIndex) => {
        const card = makeElement("div");
        card.style.padding = "8px";
        card.style.backgroundColor = "#20252b";
        card.style.border = "1px solid #3b4652";
        card.style.borderRadius = "6px";
        card.style.display = "flex";
        card.style.flexDirection = "column";
        card.style.gap = "6px";
        card.style.flexShrink = "0";
        card.style.minHeight = "150px";

        if (shot.previewDataUrl) {
          const image = makeElement("img");
          image.src = shot.previewDataUrl;
          image.style.width = "100%";
          image.style.maxHeight = "110px";
          image.style.height = "110px";
          image.style.objectFit = "cover";
          image.style.borderRadius = "4px";
          card.appendChild(image);
        }

        const timelineSeconds = Math.max(
          0,
          analysis.clip.startSeconds +
          shot.startSeconds -
          analysis.clip.inPointSeconds
        );
        const timeButton = makeElement(
          "div",
          `Plano ${shotIndex + 1} · ${formatTimecode(timelineSeconds)}`
        );
        timeButton.style.color = "#6eb6ff";
        timeButton.style.cursor = "pointer";
        timeButton.style.margin = "6px 0";
        timeButton.addEventListener("click", async () => {
          const activeProject = await ppro.Project.getActiveProject();
          const activeSequence = activeProject
            ? await activeProject.getActiveSequence()
            : sequence;
          if (!activeSequence) return;
          const moved = await activeSequence.setPlayerPosition(
            ppro.TickTime.createWithSeconds(timelineSeconds)
          );
          if (!moved) {
            status.textContent =
              `No se pudo ir a ${formatTimecode(timelineSeconds)}.`;
          }
        });
        card.appendChild(timeButton);

        const shotType = shot.mode === "split"
          ? "Ambos (50/50)"
          : shot.mode === "original"
            ? "Plano original"
            : `Persona ${shot.subjectId || "A"}`;
        const choicePreview = makeElement("div", shotType);
        choicePreview.style.padding = "7px 9px";
        choicePreview.style.backgroundColor = "#15191e";
        choicePreview.style.border = "1px solid #3b4652";
        choicePreview.style.borderRadius = "5px";
        choicePreview.style.color = "#d7dce2";
        card.appendChild(choicePreview);
        shotList.appendChild(card);
      });
    });
    updateCollapsedState();
    shotEditor.style.display = "flex";
    shotEditor.style.flexShrink = "0";
  }

  setBusy(false);

  const savedControls = {
    mode, speed, preset, profile, minShot, speakerDelay,
    sensitivity, peopleMode, framing, editStyle,
    thresholdPreset, thresholdInput,
    minimumSilence, minimumSilenceInput,
    silencePadding, silencePaddingInput, silenceMode
  };
  const applyPreset = (presetName) => {
    if (presetName === "gota") {
      profile.value = "camera_shots";
      minShot.value = "1.8";
      speakerDelay.value = "0.4";
      sensitivity.value = "strict";
      peopleMode.value = "auto";
      framing.value = "1.2";
      editStyle.value = "cuts";
    } else if (presetName === "interview") {
      profile.value = "podcast_calm";
      minShot.value = "3";
      speakerDelay.value = "0.7";
      sensitivity.value = "balanced";
      peopleMode.value = "auto";
      framing.value = "1.45";
      editStyle.value = "cuts";
    } else if (presetName === "reels") {
      profile.value = "reels_fast";
      minShot.value = "1";
      speakerDelay.value = "0.2";
      sensitivity.value = "strict";
      peopleMode.value = "single";
      framing.value = "1";
      editStyle.value = "keyframes";
    }
  };
  preset.addEventListener("change", () => applyPreset(preset.value));
  mode.addEventListener("change", () => {
    apply.textContent = mode.value === "multicam"
      ? "Crear edicion multicamara con reencuadre"
      : "Crear copia vertical con reencuadre";
  });
  try {
    const saved = JSON.parse(
      window.localStorage.getItem("autoframeByGotaSettings") || "{}"
    );
    Object.entries(savedControls).forEach(([name, control]) => {
      if (saved[name] != null) control.value = saved[name];
      control.addEventListener("change", () => {
        const values = {};
        Object.entries(savedControls).forEach(([key, item]) => {
          values[key] = item.value;
        });
        window.localStorage.setItem(
          "autoframeByGotaSettings", JSON.stringify(values)
        );
      });
    });
  } catch (_) {
    // Premiere puede desactivar el almacenamiento en algunos entornos.
  }
  apply.textContent = mode.value === "multicam"
    ? "Crear edicion multicamara con reencuadre"
    : "Crear copia vertical con reencuadre";

  cancel.addEventListener("click", async () => {
    if (!currentJobId) return;
    cancelRequested = true;
    cancel.style.display = "none";
    status.textContent = "Cancelando analisis...";
    try {
      await fetch(`${SERVICE_URL}/v1/jobs/${currentJobId}`, {
        method: "DELETE"
      });
    } catch (_) {
      // El bucle de consulta tambien se detendra localmente.
    }
  });

  analyze.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true, true);
    setApplyEnabled(false);
    lastAnalyses = [];
    currentJobId = null;
    cancelRequested = false;
    review.style.display = "none";
    shotEditor.style.display = "none";
    progress.value = 0;
    percent.textContent = "0%";
    status.textContent = "Esperando al motor local...";
    try {
      await waitForLocalService({ attempts: 60, delayMs: 500 });
      await requireSignedLicense();
      status.textContent = "Leyendo seleccion de Premiere...";
      const project = await ppro.Project.getActiveProject();
      if (!project) throw new Error("No hay un proyecto activo.");
      const sequence = await project.getActiveSequence();
      if (!sequence) throw new Error("No hay una secuencia activa.");
      const clips = await collectSelectedVideoClips(sequence);

      if (!clips.length) {
        throw new Error(
          "Selecciona un clip de video o una multicamara en la linea de tiempo."
        );
      }
      const hasMulticam = clips.some((clip) => clip.multicam);
      const hasRegular = clips.some((clip) => !clip.multicam);
      if (hasMulticam && hasRegular) {
        throw new Error(
          "Analiza la multicamara por separado de los clips normales."
        );
      }
      if (mode.value === "multicam" && !hasMulticam) {
        throw new Error(
          "El clip seleccionado no es una secuencia multicamara anidada."
        );
      }
      if (hasMulticam) {
        mode.value = "multicam";
        apply.textContent = "Crear edicion multicamara con reencuadre";
      }

      const summaries = [];
      for (let index = 0; index < clips.length; index += 1) {
        const clip = clips[index];
        status.textContent = `Analizando ${index + 1}/${clips.length}: ${clip.name}`;
        const response = await fetch(`${SERVICE_URL}/v2/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mediaPath: clip.mediaPath,
            sampleFps: Number(speed.value),
            profile: profile.value,
            sensitivity: sensitivity.value,
            peopleMode: peopleMode.value,
            framing: Number(framing.value),
            rules: {
              minShotSeconds: Number(minShot.value),
              speakerDelaySeconds: Number(speakerDelay.value),
              splitOnOverlap: peopleMode.value !== "single"
            },
            startSeconds: clip.inPointSeconds,
            endSeconds: clip.outPointSeconds
          })
        });
        if (!response.ok) {
          throw new Error(`Servicio local ${response.status}: ${await response.text()}`);
        }
        const created = await response.json();
        currentJobId = created.jobId;
        let job;
        const jobStartedAt = Date.now();
        do {
          if (cancelRequested) {
            throw new Error("Analisis cancelado.");
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          const jobResponse = await fetch(
            `${SERVICE_URL}/v1/jobs/${created.jobId}`
          );
          if (!jobResponse.ok) {
            throw new Error(`No se pudo consultar el progreso: ${jobResponse.status}`);
          }
          job = await jobResponse.json();
          const currentProgress = Number(job.progress) || 0;
          const overallProgress = Math.round(
            ((index + currentProgress / 100) / clips.length) * 100
          );
          const remaining = estimateRemainingSeconds(jobStartedAt, currentProgress);
          progress.value = overallProgress;
          percent.textContent = `${overallProgress}%`;
          status.textContent =
            `Analizando ${index + 1}/${clips.length}: ${clip.name}\n` +
            `Progreso: ${overallProgress}%` +
            (remaining == null
              ? "\nCalculando tiempo restante..."
              : `\nTiempo estimado: ${formatRemainingTime(remaining)}`);
        } while (
          job.status === "queued" ||
          job.status === "running" ||
          job.status === "canceling"
        );

        if (job.status === "failed" || job.status === "canceled") {
          throw new Error(job.error || "El analisis fallo.");
        }
        const result = job.result;
        lastAnalyses.push({ clip, result });
        try {
          await fetch(`${SERVICE_URL}/v1/jobs/${created.jobId}`, {
            method: "DELETE"
          });
        } catch (_) {
          // The service also removes abandoned jobs after ten days.
        }
        summaries.push(
          `${clip.name}: ${result.keyframes.length} keyframes, ` +
          `confianza ${result.meanConfidence.toFixed(2)}\n` +
          `Plan editorial: ${(result.shots || []).length} planos | ` +
          `Avisos para revisar: ${(result.warnings || []).length}\n` +
          `Cambios sugeridos por el ritmo: ${result.sceneCutCount || 0}\n` +
          `Una persona: ${result.singleFrames} muestras | ` +
          `Dos personas: ${result.splitFrames} muestras`
        );
        currentJobId = null;
      }
      status.textContent = `Plan listo (sin aplicar)\n\n${summaries.join("\n")}`;
      const totalWarnings = lastAnalyses.reduce(
        (sum, item) => sum + (item.result.warnings || []).length, 0
      );
      const meanQuality = lastAnalyses.length
        ? lastAnalyses.reduce(
          (sum, item) => sum + Number(item.result.meanConfidence || 0), 0
        ) / lastAnalyses.length
        : 0;
      const qualityScore = Math.max(
        0, Math.min(100, Math.round(meanQuality * 100 - totalWarnings * 4))
      );
      const warningTimes = lastAnalyses.flatMap((item) =>
        (item.result.warnings || []).slice(0, 5).map((warning) =>
          `${formatTimecode(warning.timeSeconds)}: ` +
          `${warning.message || warning.type}`
        )
      );
      review.style.display = "block";
      review.textContent =
        `Revision previa\nCalidad estimada: ${qualityScore}/100\n` +
        `Segmentos dudosos: ${totalWarnings}` +
        (warningTimes.length ? `\n\n${warningTimes.join("\n")}` : "\nSin avisos.");
      progress.value = 100;
      percent.textContent = "100%";
      lastProject = project;
      lastSequence = sequence;
      renderShotEditor(sequence, lastAnalyses);
      setApplyEnabled(lastAnalyses.length > 0);
    } catch (error) {
      status.textContent = `Error: ${error.message || String(error)}`;
    } finally {
      currentJobId = null;
      setBusy(false);
    }
  });

  apply.addEventListener("click", async () => {
    if (busy || !lastAnalyses.length || !lastProject || !lastSequence) return;
    setBusy(true, false);
    setApplyEnabled(false);
    status.textContent =
      (editStyle.value === "cuts"
        ? "Creando copia vertical con cortes y encuadres fijos...\n"
        : "Creando copia vertical y aplicando keyframes...\n") +
      "La secuencia original no sera modificada.";
    try {
      const refreshed = await refreshAnalysisLocations(lastSequence, lastAnalyses);
      if (refreshed) {
        status.textContent +=
          `\nSe actualizaron ${refreshed} clips movidos en la línea de tiempo.`;
      }
      const isMulticam = lastAnalyses.every(
        (analysis) => Boolean(analysis.clip.multicam)
      );
      const clone = isMulticam
        ? await applyMulticamReframe(
          lastProject, lastSequence, lastAnalyses, Number(minShot.value)
        )
        : await applyReframe(
          lastProject, lastSequence, lastAnalyses, editStyle.value
        );
      status.textContent =
        `${isMulticam ? "Edicion multicamara" : "Copia vertical"} creada: ` +
        `${clone.name}\n\n` +
        (isMulticam
          ? "Los angulos quedaron como cortes normales y el audio maestro se conservo."
          : editStyle.value === "cuts"
          ? "Cada segmento tiene Position y Scale fijos para que puedas corregirlo manualmente."
          : "Revisa Position y Scale. Puedes deshacer los cambios o volver a la secuencia original.");
    } catch (error) {
      status.textContent =
        `No se pudo aplicar: ${error.message || String(error)}\n\n` +
        "La secuencia original permanece intacta.";
      setApplyEnabled(true);
    } finally {
      setBusy(false);
    }
  });

  analyze.addEventListener("keydown", (event) => {
    if (!busy && (event.key === "Enter" || event.key === " ")) {
      analyze.click();
    }
  });

  // Primera base visual de subtítulos: los estilos se pueden elegir y
  // previsualizar desde ahora. El motor de transcripción local se conecta en
  // la siguiente etapa, sin obligar al usuario a contratar una API externa.
  const captionsPanel = makeElement("div");
  captionsPanel.style.display = "flex";
  captionsPanel.style.flexDirection = "column";
  captionsPanel.style.gap = "8px";
  panel.appendChild(captionsPanel);
  let captionsCollapsed = true;
  try {
    captionsCollapsed = window.localStorage.getItem("gckCaptionsCollapsed") !== "false";
  } catch (_) { /* inicia plegado */ }
  const captionsHeading = makeElement("div");
  captionsHeading.style.fontWeight = "bold";
  captionsHeading.style.padding = "8px";
  captionsHeading.style.backgroundColor = "#20252b";
  captionsHeading.style.border = "1px solid #3b4652";
  captionsHeading.style.borderRadius = "6px";
  captionsHeading.style.cursor = "pointer";
  captionsPanel.appendChild(captionsHeading);
  const captionsBody = makeElement("div");
  captionsBody.style.flexDirection = "column";
  captionsBody.style.gap = "10px";
  captionsBody.style.padding = "10px";
  captionsBody.style.backgroundColor = "#1c2026";
  captionsBody.style.border = "1px solid #3a424c";
  captionsBody.style.borderRadius = "7px";
  captionsPanel.appendChild(captionsBody);
  const captionsHelp = makeElement("div", "Personaliza el estilo antes de generar los subtítulos.");
  captionsHelp.style.fontSize = "10px";
  captionsHelp.style.color = "#bdc7d3";
  captionsBody.appendChild(captionsHelp);
  const captionsStyleLabel = makeElement("label", "Estilo de animación");
  captionsStyleLabel.style.display = "flex";
  captionsStyleLabel.style.justifyContent = "space-between";
  captionsStyleLabel.style.alignItems = "center";
  captionsStyleLabel.style.fontSize = "11px";
  const captionsStyle = makeElement("select");
  [["gota-pop", "Gota Pop (palabra destacada)"], ["minimal", "Minimal (limpio)"], ["impact", "Impacto (grande)"]]
    .forEach(([value, label]) => { const option = makeElement("option", label); option.value = value; captionsStyle.appendChild(option); });
  captionsStyle.style.width = "58%";
  captionsStyleLabel.appendChild(captionsStyle);
  captionsBody.appendChild(captionsStyleLabel);
  // Los controles nativos de rango de UXP han tenido comportamientos distintos
  // según la versión de Premiere (en algunos equipos saltan de mínimo a máximo).
  // Este control mide directamente la posición dentro de su propia barra.
  const makePrecisionSlider = (minimum, maximum, initial, step = 1) => {
    const control = { value: String(initial), onChange: null };
    const wrap = makeElement("div"); wrap.style.display = "flex"; wrap.style.width = "100%"; wrap.style.minWidth = "0"; wrap.style.alignItems = "center"; wrap.style.gap = "10px";
    const track = makeElement("div"); track.style.position = "relative"; track.style.height = "4px"; track.style.minWidth = "86px"; track.style.flex = "1 1 86px"; track.style.backgroundColor = "#59616c"; track.style.borderRadius = "3px"; track.style.cursor = "pointer";
    const fill = makeElement("div"); fill.style.position = "absolute"; fill.style.left = "0"; fill.style.top = "0"; fill.style.height = "100%"; fill.style.backgroundColor = "#4a94e6"; fill.style.borderRadius = "3px";
    const thumb = makeElement("div"); thumb.style.position = "absolute"; thumb.style.top = "50%"; thumb.style.width = "13px"; thumb.style.height = "13px"; thumb.style.marginTop = "-6.5px"; thumb.style.marginLeft = "-6.5px"; thumb.style.borderRadius = "50%"; thumb.style.backgroundColor = "#d9e2ec"; thumb.style.border = "2px solid #303842"; thumb.style.boxSizing = "border-box"; thumb.style.pointerEvents = "none";
    // El número también es un campo editable: escribir 17.1 es más cómodo
    // que arrastrar cuando se busca una medida exacta.
    const readout = makeElement("input"); readout.type = "text"; readout.value = String(initial); readout.style.width = "48px"; readout.style.padding = "3px 4px"; readout.style.boxSizing = "border-box"; readout.style.textAlign = "right"; readout.style.color = "#9dc6f5"; readout.style.fontSize = "11px"; readout.style.backgroundColor = "#11151a"; readout.style.border = "1px solid #4c5866"; readout.style.borderRadius = "3px";
    track.appendChild(fill); track.appendChild(thumb); wrap.appendChild(track); wrap.appendChild(readout);
    const refresh = () => { const raw = Number(control.value); const ratio = Math.max(0, Math.min(1, (raw - minimum) / (maximum - minimum))); fill.style.width = `${ratio * 100}%`; thumb.style.left = `${ratio * 100}%`; readout.value = Number(raw.toFixed(step < 1 ? 1 : 0)).toString(); };
    const setFromEvent = (event) => {
      const rect = track.getBoundingClientRect();
      // offsetX suele ser el dato más preciso en UXP. Si no existe, usamos
      // clientX; nunca dividimos por un ancho 0 cuando Premiere aún acomoda el panel.
      const localX = Number.isFinite(event.offsetX) ? event.offsetX : Number(event.clientX) - rect.left;
      const width = Math.max(1, Number(rect.width) || Number(track.offsetWidth) || 1);
      const ratio = Math.max(0, Math.min(1, localX / width));
      const raw = minimum + ratio * (maximum - minimum);
      const rounded = Math.round(raw / step) * step;
      control.value = String(Math.max(minimum, Math.min(maximum, Number(rounded.toFixed(2)))));
      refresh(); if (control.onChange) control.onChange();
    };
    track.addEventListener("pointerdown", (event) => setFromEvent(event));
    track.addEventListener("pointermove", (event) => { if (event.buttons) setFromEvent(event); });
    const applyEnteredValue = () => {
      const entered = Number(String(readout.value).replace(",", "."));
      if (!Number.isFinite(entered)) { refresh(); return; }
      const rounded = Math.round(entered / step) * step;
      control.value = String(Math.max(minimum, Math.min(maximum, Number(rounded.toFixed(2)))));
      refresh(); if (control.onChange) control.onChange();
    };
    readout.addEventListener("input", applyEnteredValue);
    readout.addEventListener("change", applyEnteredValue);
    refresh(); control.element = wrap; return control;
  };
  const captionsSizeLabel = makeElement("div", "Tamaño del texto");
  captionsSizeLabel.style.fontSize = "11px";
  captionsSizeLabel.style.display = "flex";
  captionsSizeLabel.style.flexDirection = "column";
  captionsSizeLabel.style.gap = "6px";
  const captionsSize = makePrecisionSlider(12, 180, 42, 1);
  captionsSizeLabel.appendChild(captionsSize.element);
  captionsBody.appendChild(captionsSizeLabel);
  const captionsWordsLabel = makeElement("div", "Máximo de palabras por subtítulo");
  captionsWordsLabel.style.fontSize = "11px";
  captionsWordsLabel.style.display = "flex";
  captionsWordsLabel.style.flexDirection = "column";
  captionsWordsLabel.style.gap = "6px";
  const captionsWords = makePrecisionSlider(2, 16, 6, 1);
  captionsWordsLabel.appendChild(captionsWords.element);
  captionsBody.appendChild(captionsWordsLabel);
  const captionsPositionLabel = makeElement("div", "Posición vertical (entre guías)");
  captionsPositionLabel.style.fontSize = "11px";
  captionsPositionLabel.style.display = "flex";
  captionsPositionLabel.style.flexDirection = "column";
  captionsPositionLabel.style.gap = "6px";
  // La MOGRT ya contiene una composición horizontal; 70% la alinea con la
  // guía blanca inferior de Premiere sin pegarla al borde del cuadro.
  const captionsPosition = makePrecisionSlider(45, 88, 70, 1);
  captionsPositionLabel.appendChild(captionsPosition.element);
  captionsBody.appendChild(captionsPositionLabel);
  const captionsFontLabel = makeElement("label", "Tipografía instalada");
  captionsFontLabel.style.fontSize = "11px";
  const captionsFont = makeElement("select");
  const initialFont = makeElement("option", "Cargando fuentes de este equipo…");
  initialFont.value = "Arial";
  captionsFont.appendChild(initialFont);
  captionsFontLabel.appendChild(captionsFont);
  captionsBody.appendChild(captionsFontLabel);
  const captionsCaseLabel = makeElement("label", "Mayúsculas / minúsculas");
  captionsCaseLabel.style.fontSize = "11px";
  const captionsCase = makeElement("select");
  [["upper", "MAYÚSCULAS"], ["normal", "Normal"], ["lower", "minúsculas"], ["title", "Tipo Título"]]
    .forEach(([value, text]) => { const option = makeElement("option", text); option.value = value; captionsCase.appendChild(option); });
  captionsCaseLabel.appendChild(captionsCase);
  captionsBody.appendChild(captionsCaseLabel);
  const hexToHsv = (hex) => {
    const value = String(hex || "#ffffff").replace("#", "");
    const r = parseInt(value.slice(0, 2), 16) / 255;
    const g = parseInt(value.slice(2, 4), 16) / 255;
    const b = parseInt(value.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b); const min = Math.min(r, g, b); const delta = max - min;
    let h = 0;
    if (delta) h = max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
    return { h: (h + 360) % 360, s: max ? delta / max : 0, v: max };
  };
  const hsvToHex = (h, s, v) => {
    const chroma = v * s; const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1)); const m = v - chroma;
    const [r, g, b] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
    return `#${[r, g, b].map((part) => Math.round((part + m) * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  };
  let openedCaptionPicker = null;
  const makeVisualColorControl = (label, initial) => {
    const control = { value: initial.toUpperCase(), onChange: null };
    const wrap = makeElement("div"); wrap.style.position = "relative";
    const row = makeElement("div"); row.style.display = "flex"; row.style.alignItems = "center"; row.style.gap = "8px";
    const name = makeElement("div", label); name.style.fontSize = "11px"; name.style.flex = "1";
    const swatch = makeElement("div"); swatch.setAttribute("role", "button"); swatch.style.width = "28px"; swatch.style.height = "20px"; swatch.style.borderRadius = "4px"; swatch.style.border = "1px solid #9099a5"; swatch.style.cursor = "pointer"; swatch.style.backgroundColor = control.value;
    const arrow = makeElement("div", "⌄"); arrow.style.color = "#b9c6d6"; arrow.style.cursor = "pointer";
    row.appendChild(name); row.appendChild(swatch); row.appendChild(arrow); wrap.appendChild(row);
    // En flujo normal: al abrirse empuja los demás ajustes en lugar de
    // taparlos como una ventana flotante.
    const picker = makeElement("div"); picker.style.display = "none"; picker.style.position = "relative"; picker.style.marginTop = "7px"; picker.style.width = "calc(100% - 18px)"; picker.style.padding = "9px"; picker.style.backgroundColor = "#292f37"; picker.style.border = "1px solid #637184"; picker.style.borderRadius = "6px"; picker.style.boxShadow = "0 6px 18px rgba(0,0,0,.55)";
    const hsv = hexToHsv(control.value);
    const field = makeElement("div"); field.style.width = "100%"; field.style.height = "118px"; field.style.cursor = "crosshair"; field.style.borderRadius = "4px";
    const hue = makeElement("div"); hue.style.position = "relative"; hue.style.width = "100%"; hue.style.height = "12px"; hue.style.marginTop = "10px"; hue.style.cursor = "pointer"; hue.style.borderRadius = "5px"; hue.style.background = "linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)";
    const hueThumb = makeElement("div"); hueThumb.style.position = "absolute"; hueThumb.style.top = "-3px"; hueThumb.style.width = "18px"; hueThumb.style.height = "18px"; hueThumb.style.marginLeft = "-9px"; hueThumb.style.borderRadius = "50%"; hueThumb.style.border = "2px solid white"; hueThumb.style.backgroundColor = "transparent"; hueThumb.style.boxSizing = "border-box"; hueThumb.style.pointerEvents = "none"; hue.appendChild(hueThumb);
    const cursor = makeElement("div"); cursor.style.position = "absolute"; cursor.style.width = "10px"; cursor.style.height = "10px"; cursor.style.borderRadius = "50%"; cursor.style.border = "2px solid white"; cursor.style.boxShadow = "0 0 2px #000"; cursor.style.pointerEvents = "none";
    const fieldWrap = makeElement("div"); fieldWrap.style.position = "relative"; fieldWrap.appendChild(field); fieldWrap.appendChild(cursor); picker.appendChild(fieldWrap); picker.appendChild(hue); wrap.appendChild(picker);
    const redraw = () => { field.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${hsv.h},100%,50%))`; cursor.style.left = `${Math.max(0, Math.min(100, hsv.s * 100))}%`; cursor.style.top = `${Math.max(0, Math.min(100, (1 - hsv.v) * 100))}%`; hueThumb.style.left = `${(hsv.h / 360) * 100}%`; swatch.style.backgroundColor = control.value; };
    const pointRatio = (event, element, vertical = false) => {
      const rect = element.getBoundingClientRect();
      const raw = vertical
        ? (Number.isFinite(event.offsetY) ? event.offsetY : Number(event.clientY) - rect.top)
        : (Number.isFinite(event.offsetX) ? event.offsetX : Number(event.clientX) - rect.left);
      const length = Math.max(1, vertical ? (Number(rect.height) || Number(element.offsetHeight)) : (Number(rect.width) || Number(element.offsetWidth)));
      return Math.max(0, Math.min(1, raw / length));
    };
    const commit = (event) => { hsv.s = pointRatio(event, field); hsv.v = 1 - pointRatio(event, field, true); control.value = hsvToHex(hsv.h, hsv.s, hsv.v); redraw(); if (control.onChange) control.onChange(); };
    const commitHue = (event) => { hsv.h = Math.round(pointRatio(event, hue) * 360) % 360; control.value = hsvToHex(hsv.h, hsv.s, hsv.v); redraw(); if (control.onChange) control.onChange(); };
    field.addEventListener("pointerdown", (event) => { commit(event); }); field.addEventListener("pointermove", (event) => { if (event.buttons) commit(event); });
    hue.addEventListener("pointerdown", commitHue); hue.addEventListener("pointermove", (event) => { if (event.buttons) commitHue(event); });
    const close = () => {
      picker.style.display = "none";
      if (openedCaptionPicker === control) openedCaptionPicker = null;
    };
    const toggle = () => {
      if (openedCaptionPicker && openedCaptionPicker !== control) openedCaptionPicker.close();
      const opening = picker.style.display === "none";
      picker.style.display = opening ? "block" : "none";
      openedCaptionPicker = opening ? control : null;
      redraw();
    };
    swatch.addEventListener("click", toggle); arrow.addEventListener("click", toggle); redraw();
    control.element = wrap; control.close = close; return control;
  };
  const captionsColorControl = makeVisualColorControl("Color del texto", "#FFFFFF");
  const captionsStrokeControl = makeVisualColorControl("Color del trazo", "#000000");
  const captionsShadowControl = makeVisualColorControl("Color de sombra", "#000000");
  const captionsGlowControl = makeVisualColorControl("Color del glow (Gota Pop)", "#20B7FF");
  const captionsImpactControl = makeVisualColorControl("Color del destacado (Impacto)", "#F5CC38");
  captionsBody.appendChild(captionsColorControl.element);
  captionsBody.appendChild(captionsStrokeControl.element);
  const captionsStrokeLabel = makeElement("div", "Grosor del trazo"); captionsStrokeLabel.style.fontSize = "11px"; captionsBody.appendChild(captionsStrokeLabel);
  const captionsStrokeSize = makePrecisionSlider(0, 12, 0, 0.1); captionsBody.appendChild(captionsStrokeSize.element);
  captionsBody.appendChild(captionsShadowControl.element);
  const captionsShadowLabel = makeElement("div", "Sombra: suavidad"); captionsShadowLabel.style.fontSize = "11px"; captionsBody.appendChild(captionsShadowLabel);
  const captionsShadowBlur = makePrecisionSlider(0, 30, 4, 0.1); captionsBody.appendChild(captionsShadowBlur.element);
  const captionsShadowOffsetLabel = makeElement("div", "Desplazamiento de sombra"); captionsShadowOffsetLabel.style.fontSize = "11px"; captionsBody.appendChild(captionsShadowOffsetLabel);
  const captionsShadowOffset = makePrecisionSlider(-20, 20, 2, 0.1); captionsBody.appendChild(captionsShadowOffset.element);
  captionsBody.appendChild(captionsGlowControl.element);
  captionsBody.appendChild(captionsImpactControl.element);
  const captionsAlignLabel = makeElement("div", "Alineación");
  captionsAlignLabel.style.fontSize = "11px";
  const captionsAlignRow = makeElement("div");
  captionsAlignRow.style.display = "flex";
  captionsAlignRow.style.gap = "5px";
  const captionsAlign = { value: "center" };
  [
    ["left", "≡", "Izquierda"],
    ["center", "☰", "Centro"],
    ["right", "≣", "Derecha"],
  ].forEach(([value, icon, title]) => {
    const button = makeElement("div", icon);
    button.setAttribute("role", "button");
    button.title = title;
    button.style.flex = "1";
    button.style.padding = "6px";
    button.style.textAlign = "center";
    button.style.borderRadius = "4px";
    button.style.cursor = "pointer";
    button.style.backgroundColor = value === "center" ? "#3b4652" : "#282e35";
      button.addEventListener("click", () => {
      captionsAlign.value = value;
      Array.from(captionsAlignRow.children).forEach((item) => { item.style.backgroundColor = "#282e35"; });
      button.style.backgroundColor = "#3b4652";
      updateCaptionPreview();
      markCaptionSettingsChanged();
    });
    captionsAlignRow.appendChild(button);
  });
  captionsBody.appendChild(captionsAlignLabel);
  captionsBody.appendChild(captionsAlignRow);
  // Vista previa de subtítulos: se reconstruye de forma aislada y pinta cada
  // palabra directamente. Así no depende de la herencia CSS incompleta de UXP.
  const captionsPreview = makeElement("div");
  captionsPreview.style.height = "118px";
  captionsPreview.style.position = "relative";
  captionsPreview.style.display = "flex";
  captionsPreview.style.alignItems = "center";
  captionsPreview.style.padding = "10px";
  captionsPreview.style.boxSizing = "border-box";
  captionsPreview.style.backgroundColor = "#101216";
  captionsPreview.style.borderRadius = "6px";
  captionsPreview.style.border = "1px solid #4a5562";
  captionsPreview.style.overflow = "hidden";
  const captionPreviewStage = makeElement("div");
  captionPreviewStage.style.width = "100%";
  captionPreviewStage.style.display = "flex";
  captionPreviewStage.style.flexWrap = "wrap";
  captionPreviewStage.style.alignItems = "center";
  captionPreviewStage.style.gap = "7px";
  captionPreviewStage.style.transition = "transform 130ms ease";
  captionsPreview.appendChild(captionPreviewStage);
  captionsBody.appendChild(captionsPreview);
  captionsBody.addEventListener("pointerdown", (event) => {
    if (openedCaptionPicker && !openedCaptionPicker.element.contains(event.target)) openedCaptionPicker.close();
  });
  const captionPreviewWords = ["Esto", "se verá", "increíble"];
  const captionWords = captionPreviewWords.map((word) => {
    const piece = makeElement("span", word);
    piece.style.display = "inline-block";
    piece.style.padding = "2px 3px";
    piece.style.lineHeight = "1.05";
    piece.style.whiteSpace = "nowrap";
    piece.style.boxSizing = "border-box";
    piece.style.transformOrigin = "50% 70%";
    piece.style.transition = "transform 130ms ease, opacity 130ms ease, background-color 130ms ease, color 130ms ease, text-shadow 130ms ease";
    captionPreviewStage.appendChild(piece);
    return piece;
  });
  const captionPreviewFonts = Object.create(null);
  let captionPreviewFontFamily = "";
  let captionPreviewFontRequest = 0;
  const previewFontAlias = (fontName) => `GotaPreview_${String(fontName || "Arial").replace(/[^a-z0-9]/gi, "_")}`;
  const fontBytesToBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer); let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return btoa(binary);
  };
  const loadCaptionPreviewFont = async (fontName) => {
    const selected = String(fontName || "Arial").trim() || "Arial";
    const alias = previewFontAlias(selected);
    const requestId = ++captionPreviewFontRequest;
    captionPreviewFontFamily = `"${alias}", "${selected.replace(/"/g, "")}", Arial, sans-serif`;
    if (!captionPreviewFonts[alias]) {
      try {
        const response = await fetch(`${SERVICE_URL}/v1/font-file?fontName=${encodeURIComponent(selected)}`);
        if (!response.ok) throw new Error(`Fuente no disponible (${response.status})`);
        const data = fontBytesToBase64(await response.arrayBuffer());
        const type = String(response.headers.get("content-type") || "font/ttf").split(";")[0];
        const style = document.createElement("style");
        style.textContent = `@font-face{font-family:"${alias}";src:url(data:${type};base64,${data}) format("truetype");font-style:normal;font-weight:100 900;}`;
        (document.head || document.documentElement).appendChild(style);
        captionPreviewFonts[alias] = true;
        if (document.fonts && document.fonts.load) await document.fonts.load(`24px "${alias}"`);
      } catch (_) {
        // El nombre de fuente sigue como alternativa para las familias nativas.
      }
    }
    if (requestId === captionPreviewFontRequest) updateCaptionPreview();
  };
  const captionPaint = () => ({
    baseColor: captionsColorControl.value || "#FFFFFF",
    strokeColor: captionsStrokeControl.value || "#000000",
    strokeWidth: Math.max(0, Math.min(12, Number(captionsStrokeSize.value || 0))),
    shadowColor: captionsShadowControl.value || "#000000",
    shadowBlur: Math.max(0, Math.min(30, Number(captionsShadowBlur.value || 0))),
    shadowOffset: Math.max(-20, Math.min(20, Number(captionsShadowOffset.value || 0))),
  });
  const applyCaptionPaint = (piece, color, extraShadow = "") => {
    const paint = captionPaint();
    const shadows = [];
    if (paint.shadowBlur || paint.shadowOffset) shadows.push(`${paint.shadowOffset}px ${paint.shadowOffset}px ${paint.shadowBlur}px ${paint.shadowColor}`);
    if (extraShadow) shadows.push(extraShadow);
    piece.style.setProperty("color", color || paint.baseColor, "important");
    piece.style.setProperty("-webkit-text-fill-color", color || paint.baseColor, "important");
    piece.style.setProperty("-webkit-text-stroke-width", `${paint.strokeWidth}px`, "important");
    piece.style.setProperty("-webkit-text-stroke-color", paint.strokeColor, "important");
    piece.style.setProperty("paint-order", "stroke fill", "important");
    piece.style.setProperty("text-shadow", shadows.join(", ") || "none", "important");
  };
  const captionText = (word) => {
    if (captionsCase.value === "upper") return word.toUpperCase();
    if (captionsCase.value === "lower") return word.toLowerCase();
    if (captionsCase.value === "title") return word.replace(/\b\w/g, (letter) => letter.toUpperCase());
    return word;
  };
  let captionPreviewStep = 0;
  const animateCaptionPreview = () => {
    const style = captionsStyle.value;
    const paint = captionPaint();
    captionWords.forEach((piece, index) => {
      const active = index === captionPreviewStep;
      piece.style.backgroundColor = "transparent";
      if (style === "gota-pop") {
        piece.style.transform = active ? "translateY(-2px) scale(1.07)" : "translateY(0) scale(1)";
        piece.style.opacity = active ? "1" : "0.62";
        applyCaptionPaint(piece, active ? captionsGlowControl.value : paint.baseColor, active ? `0 0 9px ${captionsGlowControl.value || "#20B7FF"}` : "");
      } else if (style === "impact") {
        piece.style.transform = active ? "translateY(-1px) scale(1.10)" : "scale(0.96)";
        piece.style.opacity = active ? "1" : "0.55";
        piece.style.backgroundColor = active ? captionsImpactControl.value : "transparent";
        applyCaptionPaint(piece, active ? "#111111" : paint.baseColor);
      } else {
        piece.style.transform = "translateY(0) scale(1)";
        piece.style.opacity = active ? "1" : "0.76";
        applyCaptionPaint(piece, paint.baseColor);
      }
    });
    captionPreviewStep = (captionPreviewStep + 1) % captionWords.length;
  };
  const updateCaptionPreview = () => {
    const style = captionsStyle.value;
    const requestedSize = Math.round(Math.max(12, Math.min(180, Number(captionsSize.value || 22))));
    const previewSize = Math.round(Math.max(12, Math.min(48, requestedSize * 0.40)));
    const selectedFont = String(captionsFont.value || "Arial").trim() || "Arial";
    const family = captionPreviewFontFamily || `"${selectedFont.replace(/"/g, "")}", Arial, sans-serif`;
    captionsPreview.style.backgroundColor = style === "gota-pop" ? "#183b69" : style === "impact" ? "#5a176b" : "#101216";
    captionsPreview.style.border = style === "gota-pop" ? "2px solid #4ea0ff" : style === "impact" ? "2px solid #ec6bff" : "1px solid #6d737b";
    captionPreviewStage.style.justifyContent = captionsAlign.value === "left" ? "flex-start" : captionsAlign.value === "right" ? "flex-end" : "center";
    captionWords.forEach((piece, index) => {
      piece.textContent = captionText(captionPreviewWords[index]);
      piece.style.setProperty("font-family", family, "important");
      piece.style.setProperty("font-size", `${previewSize}px`, "important");
      piece.style.setProperty("font-weight", style === "impact" ? "800" : "700", "important");
      piece.style.setProperty("text-transform", captionsCase.value === "upper" ? "uppercase" : captionsCase.value === "lower" ? "lowercase" : captionsCase.value === "title" ? "capitalize" : "none", "important");
      applyCaptionPaint(piece, captionPaint().baseColor);
    });
    captionsGlowControl.element.style.display = style === "gota-pop" ? "block" : "none";
    captionsImpactControl.element.style.display = style === "impact" ? "block" : "none";
    captionPreviewStep = 0;
    animateCaptionPreview();
  };
  const updateCaptionStyle = () => { updateCaptionPreview(); markCaptionSettingsChanged(); };
  // Algunas versiones de UXP emiten `input` y otras solo `change` para los
  // selectores. Escuchamos ambos para que la previa siempre responda.
  captionsStyle.addEventListener("input", updateCaptionStyle);
  captionsStyle.addEventListener("change", updateCaptionStyle);
  captionsSize.onChange = updateCaptionStyle;
  const updateCaptionFont = () => {
    captionPreviewFontFamily = "";
    updateCaptionStyle();
    void loadCaptionPreviewFont(captionsFont.value);
  };
  captionsFont.addEventListener("input", updateCaptionFont);
  captionsFont.addEventListener("change", updateCaptionFont);
  captionsCase.addEventListener("input", updateCaptionStyle);
  captionsCase.addEventListener("change", updateCaptionStyle);
  captionsColorControl.onChange = updateCaptionStyle;
  captionsStrokeControl.onChange = updateCaptionStyle;
  captionsShadowControl.onChange = updateCaptionStyle;
  captionsGlowControl.onChange = updateCaptionStyle;
  captionsImpactControl.onChange = updateCaptionStyle;
  ;[captionsStrokeSize, captionsShadowBlur, captionsShadowOffset]
    .forEach((input) => { input.onChange = updateCaptionStyle; });
  updateCaptionPreview();
  setInterval(animateCaptionPreview, 700);
  const createCaptions = makeElement("div", "Generar subtítulos");
  createCaptions.setAttribute("role", "button");
  createCaptions.style.padding = "9px";
  createCaptions.style.textAlign = "center";
  createCaptions.style.borderRadius = "6px";
  createCaptions.style.backgroundColor = "#1473e6";
  createCaptions.style.cursor = "pointer";
  createCaptions.style.fontWeight = "600";
  createCaptions.style.marginTop = "14px";
  captionsBody.appendChild(createCaptions);
  const exportCaptions = makeElement("div", "Colocar gráficos editables en la línea");
  exportCaptions.setAttribute("role", "button");
  exportCaptions.style.padding = "8px";
  exportCaptions.style.textAlign = "center";
  exportCaptions.style.borderRadius = "6px";
  exportCaptions.style.backgroundColor = "#18a866";
  exportCaptions.style.cursor = "pointer";
  exportCaptions.style.display = "none";
  exportCaptions.style.marginTop = "8px";
  captionsBody.appendChild(exportCaptions);
  const captionsStatus = makeElement("div", "Selecciona un clip o un tramo en la línea de tiempo y genera su transcripción local.");
  captionsStatus.style.fontSize = "10px";
  captionsStatus.style.color = "#aeb8c4";
  captionsBody.appendChild(captionsStatus);
  const captionsTranscript = makeElement("div");
  captionsTranscript.style.display = "none";
  captionsTranscript.style.maxHeight = "130px";
  captionsTranscript.style.overflowY = "auto";
  captionsTranscript.style.padding = "7px";
  captionsTranscript.style.fontSize = "10px";
  captionsTranscript.style.lineHeight = "1.45";
  captionsTranscript.style.backgroundColor = "#12161b";
  captionsTranscript.style.border = "1px solid #384450";
  captionsTranscript.style.borderRadius = "5px";
  captionsBody.appendChild(captionsTranscript);
  let editableCaptionSegments = [];
  let captionsPlaced = false;
  let captionsNeedReapply = false;
  let placedCaptionGraphics = [];
  const refreshCaptionPlacementButton = () => {
    exportCaptions.style.backgroundColor = captionsPlaced ? "#56616c" : "#18a866";
    exportCaptions.style.cursor = captionsPlaced ? "default" : "pointer";
    exportCaptions.textContent = captionsPlaced
      ? "Gráficos colocados"
      : captionsNeedReapply
        ? "Aplicar cambios a gráficos"
        : "Colocar gráficos editables en la línea";
  };
  function markCaptionSettingsChanged() {
    if (!editableCaptionSegments.length) return;
    captionsNeedReapply = placedCaptionGraphics.length > 0;
    captionsPlaced = false;
    refreshCaptionPlacementButton();
  }
  async function removePlacedCaptionGraphics(project, sequence) {
    if (!placedCaptionGraphics.length) return;
    const selection = await createEmptyTrackSelection();
    let count = 0;
    for (const graphic of placedCaptionGraphics) {
      try { selection.addItem(graphic, false); count += 1; } catch (_) { /* ya no existe */ }
    }
    if (!count) { placedCaptionGraphics = []; return; }
    const editor = ppro.SequenceEditor.getEditor(sequence);
    let removed = false;
    try {
      project.lockedAccess(() => {
        removed = project.executeTransaction((compoundAction) => {
          compoundAction.addAction(editor.createRemoveItemsAction(
            selection, false, ppro.Constants.MediaType.ANY, false
          ));
        }, "Gota Creator Kit: reemplazar gráficos de subtítulos");
      });
    } catch (_) {
      removed = false;
    }
    // Si el usuario ya los eliminó desde Premiere, las referencias UXP dejan
    // de ser válidas. No frenamos la nueva colocación: simplemente limpiamos
    // la memoria del panel y continuamos con los gráficos nuevos.
    if (!removed) {
      placedCaptionGraphics = [];
      return false;
    }
    placedCaptionGraphics = [];
    return true;
  }
  captionsPosition.onChange = updateCaptionStyle;
  let fontsRetryCount = 0;
  const loadSystemFonts = async () => {
    captionsStatus.textContent = "Conectando el motor local para leer las tipografías…";
    try {
      await waitForLocalService({ attempts: 50, delayMs: 600 });
      const response = await fetch(`${SERVICE_URL}/v1/system-fonts`);
      if (!response.ok) throw new Error(`Estado ${response.status}`);
      const payload = await response.json();
      const fonts = Array.isArray(payload && payload.fonts) ? payload.fonts : [];
      while (captionsFont.firstChild) captionsFont.removeChild(captionsFont.firstChild);
      const ordered = fonts.length ? fonts : ["Arial", "Helvetica", "Times New Roman"];
      ordered.forEach((fontName) => {
        const option = makeElement("option", fontName);
        option.value = fontName;
        captionsFont.appendChild(option);
      });
      captionsFont.value = ordered.includes("Arial") ? "Arial" : ordered[0];
      updateCaptionPreview();
      void loadCaptionPreviewFont(captionsFont.value);
      captionsStatus.textContent = "Tipografías instaladas listas para la vista previa.";
    } catch (_) {
      initialFont.textContent = "Arial (no se pudo cargar la lista)";
      captionsStatus.textContent = "El motor local sigue iniciando. Las fuentes se volverán a intentar automáticamente.";
      // No dejamos el panel permanentemente en Arial si Python tardó más de
      // lo normal al encender. El siguiente intento es silencioso y conserva
      // cualquier estilo que el usuario ya haya elegido.
      if (fontsRetryCount < 2) {
        fontsRetryCount += 1;
        setTimeout(loadSystemFonts, 8000);
      }
    }
  };
  loadSystemFonts();
  const formatCaptionTime = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };
  const splitCaptionByWords = (segments, maximumWords) => {
    const limit = Math.max(2, Math.min(16, Math.round(Number(maximumWords) || 6)));
    const result = [];
    for (const segment of segments) {
      const words = String(segment.text || "").trim().split(/\s+/).filter(Boolean);
      const timedWords = Array.isArray(segment.words) ? segment.words.filter((word) => (
        word && String(word.text || "").trim()
          && Number.isFinite(Number(word.startSeconds))
          && Number.isFinite(Number(word.endSeconds))
      )) : [];
      if (words.length <= limit) { result.push({ ...segment, words: timedWords }); continue; }
      const duration = Math.max(0.1, Number(segment.endSeconds) - Number(segment.startSeconds));
      for (let start = 0; start < words.length; start += limit) {
        const end = Math.min(words.length, start + limit);
        const timedChunk = timedWords.slice(start, end);
        result.push({
          startSeconds: timedChunk.length ? Number(timedChunk[0].startSeconds) : Number(segment.startSeconds) + duration * (start / words.length),
          endSeconds: timedChunk.length ? Number(timedChunk[timedChunk.length - 1].endSeconds) : Number(segment.startSeconds) + duration * (end / words.length),
          text: words.slice(start, end).join(" "),
          words: timedChunk
        });
      }
    }
    return result;
  };
  createCaptions.addEventListener("click", async () => {
    if (createCaptions.dataset.busy === "true") return;
    createCaptions.dataset.busy = "true";
    createCaptions.style.backgroundColor = "#56616c";
    createCaptions.style.cursor = "default";
    createCaptions.textContent = "Transcribiendo…";
    captionsTranscript.style.display = "none";
    try {
      captionsStatus.textContent = "Esperando al motor local de subtítulos…";
      await waitForLocalService({ attempts: 50, delayMs: 600 });
      const project = await ppro.Project.getActiveProject();
      const sequence = await project.getActiveSequence();
      if (!sequence) throw new Error("Abre una secuencia y selecciona un clip o tramo antes de transcribir.");
      const clips = await collectSelectedSilenceClips(sequence);
      if (!clips.length) throw new Error("Selecciona un clip de video o audio en la línea de tiempo.");
      // La primera selección define el tramo. Así no transcribimos por accidente
      // todo el archivo fuente si el usuario solo montó unos segundos.
      const clip = clips[0];
      captionsStatus.textContent = "Preparando audio y cargando el modelo local… La primera vez puede tardar unos minutos.";
      const response = await fetch(`${SERVICE_URL}/v1/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaPath: clip.mediaPath,
          startSeconds: clip.inPointSeconds,
          endSeconds: clip.outPointSeconds,
          language: "es",
          model: "base"
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "No se pudo transcribir el medio seleccionado.");
      const segments = Array.isArray(payload.segments) ? payload.segments : [];
      if (!segments.length) {
        captionsStatus.textContent = "No detecté diálogo en este tramo. Prueba con otro clip o revisa que su audio no esté silenciado.";
        return;
      }
      editableCaptionSegments = splitCaptionByWords(segments.map((segment) => ({
        // Conversión de tiempo fuente a tiempo de la secuencia; evita que un
        // SRT del tramo seleccionado se desplace al inicio de la edición.
        startSeconds: clip.startSeconds + (segment.startSeconds - clip.inPointSeconds) * (clip.sourceToTimelineScale || 1),
        endSeconds: clip.startSeconds + (segment.endSeconds - clip.inPointSeconds) * (clip.sourceToTimelineScale || 1),
        text: String(segment.text || ""),
        words: (Array.isArray(segment.words) ? segment.words : []).map((word) => ({
          text: String(word.text || ""),
          startSeconds: clip.startSeconds + (Number(word.startSeconds) - clip.inPointSeconds) * (clip.sourceToTimelineScale || 1),
          endSeconds: clip.startSeconds + (Number(word.endSeconds) - clip.inPointSeconds) * (clip.sourceToTimelineScale || 1)
        }))
      })), captionsWords.value);
      captionsTranscript.innerHTML = "";
      editableCaptionSegments.forEach((segment) => {
        const row = makeElement("div");
        row.style.padding = "3px 0";
        const time = makeElement("span", formatCaptionTime(segment.startSeconds));
        time.style.color = "#78b8f4";
        time.style.marginRight = "6px";
        row.appendChild(time);
        const text = makeElement("input");
        text.type = "text";
        text.value = segment.text;
        text.style.width = "calc(100% - 46px)";
        text.style.backgroundColor = "#20262d";
        text.style.border = "1px solid #475361";
        text.style.borderRadius = "3px";
        text.style.color = "#f2f4f7";
        text.style.padding = "3px 5px";
        text.addEventListener("input", () => { segment.text = text.value; markCaptionSettingsChanged(); });
        row.appendChild(text);
        captionsTranscript.appendChild(row);
      });
      captionsTranscript.style.display = "block";
      captionsPlaced = false;
      captionsNeedReapply = placedCaptionGraphics.length > 0;
      exportCaptions.style.display = "block";
      refreshCaptionPlacementButton();
      captionsStatus.textContent = `Transcripción lista: ${editableCaptionSegments.length} líneas. Corrige lo que quieras y luego colócalas como gráficos editables.`;
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      captionsStatus.textContent =
        message === "Network request failed"
          ? "El motor local todavía no responde. Espera unos segundos y vuelve a intentar."
          : `No se pudo transcribir: ${message}`;
    } finally {
      createCaptions.dataset.busy = "false";
      createCaptions.style.backgroundColor = "#1473e6";
      createCaptions.style.cursor = "pointer";
      createCaptions.textContent = "Generar subtítulos";
    }
  });
  exportCaptions.addEventListener("click", async () => {
    if (!editableCaptionSegments.length || captionsPlaced) return;
    if (exportCaptions.dataset.busy === "true") return;
    exportCaptions.dataset.busy = "true";
    exportCaptions.style.backgroundColor = "#56616c";
    exportCaptions.style.cursor = "default";
    exportCaptions.textContent = "Colocando gráficos…";
    try {
      const project = await ppro.Project.getActiveProject();
      const sequence = await project.getActiveSequence();
      if (!sequence) throw new Error("Abre la secuencia donde quieres colocar los subtítulos.");
      const mogrtPath = await getBundledCaptionsMogrtPath();
      const editor = ppro.SequenceEditor.getEditor(sequence);
      let placed = 0;
      if (placedCaptionGraphics.length) {
        captionsStatus.textContent = "Reemplazando los gráficos anteriores…";
        await removePlacedCaptionGraphics(project, sequence);
      }
      for (let index = 0; index < editableCaptionSegments.length; index += 1) {
        const segment = editableCaptionSegments[index];
        const start = ppro.TickTime.createWithSeconds(segment.startSeconds);
        const videoTrackIndex = await findLowestAvailableTrack(sequence, "video", start);
        const captionText = captionsCase.value === "upper" ? segment.text.toUpperCase()
          : captionsCase.value === "lower" ? segment.text.toLowerCase()
            : captionsCase.value === "title" ? segment.text.replace(/\b\w/g, (letter) => letter.toUpperCase())
              : segment.text;
        const captionMogrtPath = await makeCaptionMogrt(mogrtPath, captionText, {
          font: captionsFont.value,
          fontSize: Number(captionsSize.value),
          allCaps: captionsCase.value === "upper",
          textColor: captionsColorControl.value,
          strokeColor: captionsStrokeControl.value,
          strokeSize: Number(captionsStrokeSize.value),
          shadowColor: captionsShadowControl.value,
          shadowBlur: Number(captionsShadowBlur.value),
          shadowOffset: Number(captionsShadowOffset.value),
          glowColor: captionsGlowControl.value,
          style: captionsStyle.value,
          alignment: captionsAlign.value,
          durationSeconds: Math.max(0.18, Number(segment.endSeconds) - Number(segment.startSeconds))
        });
        const inserted = await editor.insertMogrtFromPath(
          // Premiere exige índices existentes también para la pista de audio,
          // aun cuando esta MOGRT no tiene audio. 0 evita el Invalid parameter
          // que produce -1 en algunas versiones.
          captionMogrtPath, start, videoTrackIndex, 0
        );
        const graphic = Array.isArray(inserted) ? inserted[0] : null;
        if (!graphic) continue;
        // El gráfico ya está insertado. Los ajustes secundarios no pueden
        // impedir que se termine de colocar el resto si Premiere rechaza un
        // parámetro temporalmente en una versión concreta.
        try { await trimMogrtToCaption(project, graphic, segment.endSeconds - segment.startSeconds); } catch (_) {}
        try { await applySubtitlePosition(project, graphic, captionsPosition.value); } catch (_) {}
        await applySubtitleEntrance(project, graphic, captionsStyle.value, captionsPosition.value);
        placedCaptionGraphics.push(graphic);
        placed += 1;
        captionsStatus.textContent = `Colocando gráficos editables: ${placed}/${editableCaptionSegments.length}…`;
      }
      if (!placed) throw new Error("Premiere no pudo insertar la plantilla de texto.");
      captionsPlaced = true;
      captionsNeedReapply = false;
      captionsStatus.textContent = `Listo: ${placed} gráficos editables con su texto real, en pistas de video libres.`;
    } catch (error) {
      captionsStatus.textContent = `No se pudieron colocar los gráficos: ${error.message || error}`;
    } finally {
      exportCaptions.dataset.busy = "false";
      refreshCaptionPlacementButton();
    }
  });
  const updateCaptionsCollapsed = () => {
    captionsHeading.textContent = `${captionsCollapsed ? "▶" : "▼"} Subtítulos automáticos (beta)`;
    captionsBody.style.display = captionsCollapsed ? "none" : "flex";
  };
  captionsHeading.addEventListener("click", () => {
    captionsCollapsed = !captionsCollapsed;
    updateCaptionsCollapsed();
    try { window.localStorage.setItem("gckCaptionsCollapsed", String(captionsCollapsed)); } catch (_) { /* session only */ }
  });
  updateCaptionsCollapsed();
  // El panel principal funciona como los grupos de ajustes de Premiere: al
  // abrir una herramienta, las otras herramientas de trabajo se pliegan.
  const mainToolAccordions = [
    {
      heading: reframeHeading,
      isOpen: () => !reframeCollapsed,
      close: () => { reframeCollapsed = true; updateReframeCollapsed(); try { window.localStorage.setItem("autoframeReframeCollapsed", "true"); } catch (_) {} }
    },
    {
      heading: silenceHeading,
      isOpen: () => !silenceCollapsed,
      close: () => { silenceCollapsed = true; updateSilenceCollapsed(); try { window.localStorage.setItem("autoframeSilenceCollapsed", "true"); } catch (_) {} }
    },
    {
      heading: copyPasteHeading,
      isOpen: () => !copyPasteCollapsed,
      close: () => { copyPasteCollapsed = true; updateCopyPasteCollapsed(); try { window.localStorage.setItem("gckCopyPasteCollapsed", "true"); } catch (_) {} }
    },
    {
      heading: captionsHeading,
      isOpen: () => !captionsCollapsed,
      close: () => { captionsCollapsed = true; updateCaptionsCollapsed(); try { window.localStorage.setItem("gckCaptionsCollapsed", "true"); } catch (_) {} }
    }
  ];
  mainToolAccordions.forEach((current) => {
    current.heading.addEventListener("click", () => {
      // Este listener corre después del clic original que abre/cierra.
      if (!current.isOpen()) return;
      mainToolAccordions.forEach((other) => { if (other !== current) other.close(); });
    });
  });
  // Subtítulos es una herramienta principal: se coloca junto a Reencuadre y
  // Eliminar silencios, antes de Biblioteca y Licencia.
  panel.insertBefore(captionsPanel, libraryShortcut);

  Array.from(panel.children).forEach((child) => {
    child.style.flexShrink = "0";
  });
  return panel;
}

// Panel independiente de Biblioteca. Mantiene su propia vista, pero comparte
// las mismas carpetas enlazadas con el panel principal mediante localStorage.
// Las entradas se recorren solo al abrirlas para que bibliotecas grandes sigan
// siendo ágiles y no haya un límite artificial de carpetas ni archivos.
function buildLibraryPanel() {
  const panel = makeElement("div");
  panel.style.padding = "12px";
  panel.style.display = "flex";
  panel.style.flexDirection = "column";
  panel.style.gap = "8px";
  panel.style.color = "#f5f5f5";
  panel.style.height = "100%";
  panel.style.boxSizing = "border-box";
  panel.style.overflow = "auto";

  const title = makeElement("h2", "Biblioteca Gota ☔");
  title.style.margin = "0";
  title.style.fontSize = "18px";
  panel.appendChild(title);
  const help = makeElement(
    "div",
    "Enlaza todas las carpetas raíz que quieras. Los archivos se quedan en tu PC: solo se muestran aquí."
  );
  help.style.fontSize = "10px";
  help.style.color = "#b8b8b8";
  panel.appendChild(help);

  const actions = makeElement("div");
  actions.style.display = "flex";
  actions.style.gap = "7px";
  panel.appendChild(actions);
  const add = makeElement("div", "+ Añadir carpeta");
  const refresh = makeElement("div", "Actualizar");
  [add, refresh].forEach((button) => {
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    button.style.padding = "8px";
    button.style.borderRadius = "6px";
    button.style.textAlign = "center";
    button.style.cursor = "pointer";
    button.style.userSelect = "none";
  });
  add.style.backgroundColor = "#1473e6";
  add.style.flex = "1";
  refresh.style.backgroundColor = "#3d4650";
  refresh.style.flex = "0 0 82px";
  actions.appendChild(add);
  actions.appendChild(refresh);

  const search = makeElement("input");
  search.type = "search";
  search.placeholder = "Buscar en todas las carpetas…";
  search.setAttribute("aria-label", "Buscar archivo o carpeta en Biblioteca Gota");
  search.style.boxSizing = "border-box";
  search.style.width = "100%";
  search.style.height = "34px";
  search.style.minHeight = "34px";
  search.style.flexShrink = "0";
  search.style.lineHeight = "18px";
  search.style.padding = "8px 10px";
  search.style.border = "1px solid #3b4652";
  search.style.borderRadius = "6px";
  search.style.backgroundColor = "#101317";
  search.style.color = "#f5f5f5";
  search.style.outline = "none";
  panel.appendChild(search);

  const status = makeElement("div", "Cargando biblioteca…");
  status.style.fontSize = "10px";
  status.style.padding = "7px";
  status.style.backgroundColor = "#181818";
  panel.appendChild(status);

  const browser = makeElement("div");
  // UXP/Premiere no siempre calcula CSS Grid correctamente en un panel
  // acoplado. Flex conserva las tres columnas aun cuando cambia el tamaño.
  browser.style.display = "flex";
  browser.style.alignItems = "stretch";
  browser.style.gap = "8px";
  browser.style.minHeight = "0";
  browser.style.width = "100%";
  // Premiere permite acoplar el panel en zonas angostas. No imponemos un
  // ancho mínimo que esconda los elementos; el panel conserva desplazamiento
  // horizontal si el usuario lo deja muy estrecho.
  browser.style.minWidth = "0";
  browser.style.overflowX = "auto";
  browser.style.flex = "1";
  panel.appendChild(browser);
  const tree = makeElement("div");
  const contents = makeElement("div");
  [tree, contents].forEach((element) => {
    element.style.minHeight = "0";
    element.style.height = "100%";
    element.style.overflowY = "auto";
    element.style.backgroundColor = "#171a1e";
    element.style.border = "1px solid #3b4652";
    element.style.borderRadius = "6px";
  });
  tree.style.flex = "1 1 0";
  contents.style.flex = "1 1 0";
  contents.style.padding = "7px";
  browser.appendChild(tree);
  browser.appendChild(contents);

  const preview = makeElement("div");
  preview.style.display = "flex";
  preview.style.flexDirection = "column";
  preview.style.gap = "8px";
  preview.style.minHeight = "0";
  preview.style.height = "100%";
  preview.style.flex = "2 1 0";
  preview.style.overflowY = "auto";
  preview.style.backgroundColor = "#171a1e";
  preview.style.border = "1px solid #3b4652";
  preview.style.borderRadius = "6px";
  preview.style.padding = "9px";
  browser.appendChild(preview);
  const previewTitle = makeElement("div", "Vista previa");
  previewTitle.style.fontWeight = "bold";
  preview.appendChild(previewTitle);
  const previewInfo = makeElement("div", "Selecciona un archivo para previsualizarlo.");
  previewInfo.style.fontSize = "10px";
  previewInfo.style.color = "#b8b8b8";
  preview.appendChild(previewInfo);
  const previewStage = makeElement("div");
  previewStage.style.minHeight = "260px";
  previewStage.style.flex = "1 1 300px";
  previewStage.style.width = "100%";
  previewStage.style.boxSizing = "border-box";
  previewStage.style.display = "flex";
  previewStage.style.alignItems = "center";
  previewStage.style.justifyContent = "center";
  previewStage.style.backgroundColor = "#0d0f12";
  previewStage.style.borderRadius = "5px";
  preview.appendChild(previewStage);
  const previewControls = makeElement("div");
  previewControls.style.display = "flex";
  previewControls.style.gap = "6px";
  preview.appendChild(previewControls);
  const enlargePreview = makeElement("div", "Ampliar vista previa");
  enlargePreview.setAttribute("role", "button");
  enlargePreview.style.padding = "7px";
  enlargePreview.style.borderRadius = "5px";
  enlargePreview.style.backgroundColor = "#3d4650";
  enlargePreview.style.textAlign = "center";
  enlargePreview.style.cursor = "pointer";
  enlargePreview.style.fontSize = "10px";
  preview.appendChild(enlargePreview);
  const backFive = makeElement("div", "← 5 s");
  const playPause = makeElement("div", "Reproducir");
  const forwardFive = makeElement("div", "5 s →");
  [backFive, playPause, forwardFive].forEach((button) => {
    button.setAttribute("role", "button");
    button.style.padding = "7px";
    button.style.borderRadius = "5px";
    button.style.textAlign = "center";
    button.style.cursor = "pointer";
    button.style.backgroundColor = "#303943";
    button.style.fontSize = "10px";
    button.style.flex = "1";
    previewControls.appendChild(button);
  });
  const sourceMonitor = makeElement("div", "Abrir en monitor de origen");
  sourceMonitor.setAttribute("role", "button");
  sourceMonitor.style.padding = "8px";
  sourceMonitor.style.borderRadius = "5px";
  sourceMonitor.style.backgroundColor = "#3d4650";
  sourceMonitor.style.textAlign = "center";
  sourceMonitor.style.cursor = "pointer";
  sourceMonitor.style.fontSize = "10px";
  preview.appendChild(sourceMonitor);
  const place = makeElement("div", "Selecciona un archivo para colocar");
  place.setAttribute("role", "button");
  place.style.padding = "9px";
  place.style.borderRadius = "6px";
  place.style.backgroundColor = "#555555";
  place.style.opacity = "0.55";
  place.style.textAlign = "center";
  place.style.fontWeight = "600";
  place.style.fontSize = "11px";
  place.style.cursor = "default";
  preview.appendChild(place);
  const placeHint = makeElement(
    "div",
    "Se añadirá al marcador en pistas nuevas, para no sobrescribir ningún clip ni audio existente."
  );
  placeHint.style.fontSize = "9px";
  placeHint.style.color = "#999999";
  preview.appendChild(placeHint);

  const rootsKey = "gckLocalLibraryRoots";
  let roots = [];
  let activeKey = "";
  let selectedFile = null;
  let previewMedia = null;
  let previewObjectUrl = "";
  let previewLarge = false;
  const previewCache = new Map();
  let searchTimer = null;
  let searchGeneration = 0;
  try {
    const saved = JSON.parse(window.localStorage.getItem(rootsKey) || "[]");
    roots = Array.isArray(saved) ? saved : [];
  } catch (_) {
    roots = [];
  }
  const saveRoots = () => window.localStorage.setItem(rootsKey, JSON.stringify(roots));
  const clear = (element) => { while (element.firstChild) element.removeChild(element.firstChild); };
  const nameOf = (entry) => String(entry && entry.name ? entry.name : "Carpeta sin nombre");
  const row = (text, depth = 0) => {
    const element = makeElement("div", text);
    element.style.padding = "6px";
    element.style.paddingLeft = `${7 + depth * 14}px`;
    element.style.borderBottom = "1px solid #2d343b";
    element.style.fontSize = "10px";
    element.style.whiteSpace = "nowrap";
    element.style.overflow = "hidden";
    element.style.textOverflow = "ellipsis";
    element.style.cursor = "pointer";
    return element;
  };
  const normalizeSearch = (value) => String(value || "").trim().toLocaleLowerCase();
  const pathLabel = (path) => path.filter(Boolean).join(" › ");
  const fileUrl = (file) => {
    const path = String(file && file.nativePath ? file.nativePath : "");
    if (!path) return "";
    return /^file:/i.test(path)
      ? path
      : `file:///${path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
  };
  const clearPreview = () => {
    while (previewStage.firstChild) previewStage.removeChild(previewStage.firstChild);
    if (previewObjectUrl && window.URL && typeof window.URL.revokeObjectURL === "function") {
      try { window.URL.revokeObjectURL(previewObjectUrl); } catch (_) { /* ignored */ }
    }
    previewObjectUrl = "";
    previewMedia = null;
    playPause.textContent = "Reproducir";
  };
  const setPreviewLarge = (large) => {
    previewLarge = large;
    enlargePreview.textContent = large ? "Reducir vista previa" : "Ampliar vista previa";
    if (large) {
      previewStage.style.position = "fixed";
      previewStage.style.left = "8px";
      previewStage.style.top = "8px";
      previewStage.style.right = "8px";
      previewStage.style.bottom = "8px";
      previewStage.style.zIndex = "999";
      previewStage.style.padding = "32px 12px 12px";
      previewStage.style.height = "auto";
      previewStage.style.backgroundColor = "#090b0e";
      const visibleMedia = previewMedia || previewStage.firstChild;
      if (visibleMedia && visibleMedia.style) { visibleMedia.style.maxHeight = "100%"; visibleMedia.style.height = "100%"; }
    } else {
      previewStage.style.position = "static";
      previewStage.style.left = ""; previewStage.style.top = ""; previewStage.style.right = ""; previewStage.style.bottom = "";
      previewStage.style.zIndex = ""; previewStage.style.padding = ""; previewStage.style.height = "";
      const visibleMedia = previewMedia || previewStage.firstChild;
      if (visibleMedia && visibleMedia.style) { visibleMedia.style.maxHeight = "260px"; visibleMedia.style.height = ""; }
    }
  };
  enlargePreview.addEventListener("click", () => setPreviewLarge(!previewLarge));
  const mediaMimeType = (extension) => ({
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
    aif: "audio/aiff", aiff: "audio/aiff", ogg: "audio/ogg", flac: "audio/flac",
    mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp"
  })[extension] || "application/octet-stream";
  const drawAudioWave = async (file, holder) => {
    const wave = makeElement("div");
    wave.style.width = "100%";
    wave.style.height = "auto";
    wave.style.minHeight = "150px";
    wave.style.flex = "1";
    wave.style.display = "flex";
    wave.style.alignItems = "center";
    wave.style.gap = "2px";
    wave.style.padding = "6px";
    wave.style.backgroundColor = "#101a14";
    wave.style.border = "1px solid #2e6c49";
    wave.style.borderRadius = "4px";
    wave.title = "Forma de onda del archivo";
    holder.appendChild(wave);
    let values = [];
    try {
      const binary = await file.read({ format: storage.formats.binary });
      const audioContext = window.AudioContext ? new window.AudioContext() : null;
      if (audioContext && typeof audioContext.decodeAudioData === "function") {
        const decoded = await audioContext.decodeAudioData(binary.slice(0));
        const channel = decoded.getChannelData(0);
        const bars = 56;
        for (let bar = 0; bar < bars; bar += 1) {
          const start = Math.floor((bar * channel.length) / bars);
          const end = Math.max(start + 1, Math.floor(((bar + 1) * channel.length) / bars));
          let peak = 0;
          for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(channel[index] || 0));
          values.push(peak);
        }
        if (typeof audioContext.close === "function") await audioContext.close();
      } else {
        const bytes = new Uint8Array(binary);
        for (let bar = 0; bar < 56; bar += 1) values.push(Math.abs((bytes[Math.floor((bar * bytes.length) / 56)] || 128) - 128) / 128);
      }
    } catch (_) {
      // Se muestra una onda neutral si el códec no se puede decodificar en UXP.
      values = Array.from({ length: 56 }, (_, index) => 0.18 + ((index * 17) % 25) / 100);
    }
    values.forEach((value) => {
      const bar = makeElement("div");
      bar.style.flex = "1";
      bar.style.minWidth = "1px";
      bar.style.height = `${Math.max(8, Math.min(128, 10 + value * 118))}px`;
      bar.style.backgroundColor = "#63c97e";
      bar.style.borderRadius = "2px";
      wave.appendChild(bar);
    });
  };
  const setPlaceEnabled = (enabled) => {
    place.textContent = enabled ? "Añadir en línea de tiempo" : "Selecciona un archivo para colocar";
    place.style.backgroundColor = enabled ? "#20a464" : "#555555";
    place.style.opacity = enabled ? "1" : "0.55";
    place.style.cursor = enabled ? "pointer" : "default";
  };
  const requestPreviewUrl = async (file) => {
    const nativePath = String(file && file.nativePath ? file.nativePath : "");
    if (!nativePath) throw new Error("El archivo no tiene una ruta local disponible.");
    const response = await fetch(`${SERVICE_URL}/v1/preview/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaPath: nativePath })
    });
    if (!response.ok) {
      let detail = "El motor local no pudo preparar este archivo.";
      try { detail = (await response.json()).detail || detail; } catch (_) { /* ignored */ }
      throw new Error(detail);
    }
    const data = await response.json();
    if (!data || !data.url) throw new Error("El motor local no devolvió una URL de vista previa.");
    return data;
  };
  const cachePreviewForPanel = async (file, preview) => {
    const key = String(file.nativePath || preview.token || preview.url);
    const cached = previewCache.get(key);
    if (cached) return cached;
    const response = await fetch(`${SERVICE_URL}${preview.url}`);
    if (!response.ok) throw new Error("No se pudo descargar la vista previa convertida.");
    const binary = await response.arrayBuffer();
    const temporaryFolder = await localFileSystem.getTemporaryFolder();
    const extension = String(preview.extension || ".mp4").replace(/[^.a-z0-9]/gi, "") || ".mp4";
    const fileName = `gck-preview-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`;
    const cachedFile = await temporaryFolder.createFile(fileName, { overwrite: true });
    await cachedFile.write(binary, { format: storage.formats.binary });
    const url = String(cachedFile.url || "");
    if (!url) throw new Error("UXP no devolvió una URL para el caché de vista previa.");
    previewCache.set(key, url);
    return url;
  };
  const showPreview = async (file) => {
    selectedFile = file;
    clearPreview();
    setPlaceEnabled(true);
    const name = nameOf(file);
    const extension = (name.split(".").pop() || "").toLowerCase();
    previewInfo.textContent = `${name}${extension ? ` · ${extension.toUpperCase()}` : ""}`;
    previewStage.appendChild(makeElement("div", "Preparando vista previa…"));
    // El motor local entrega una URL HTTP temporal del archivo elegido. Así el
    // reproductor HTML del propio panel funciona sin pedirle a Premiere que lo
    // abra en el Monitor de origen.
    let source = "";
    let playerSource = "";
    try {
      const preview = await requestPreviewUrl(file);
      // WebView utiliza el reproductor multimedia aislado de UXP. La copia
      // convertida queda únicamente en caché temporal del motor local y se
      // elimina sola; no toca las carpetas del usuario.
      playerSource = `${SERVICE_URL}${preview.playerUrl || preview.url}`;
      source = `${SERVICE_URL}${preview.url}`;
    } catch (serviceError) {
      // Si el motor aún no se inició, se intenta la URL con permiso de UXP.
      // Es una alternativa limitada, pero preserva imágenes en instalaciones
      // antiguas mientras se muestra una explicación clara al usuario.
      source = String(file && file.url ? file.url : fileUrl(file));
      previewInfo.textContent = `${name} · Vista previa local limitada: ${serviceError.message || String(serviceError)}`;
    }
    if (!source && window.URL && typeof window.URL.createObjectURL === "function") {
      try {
        const binary = await file.read({ format: storage.formats.binary });
        previewObjectUrl = window.URL.createObjectURL(new Blob([binary], { type: mediaMimeType(extension) }));
        source = previewObjectUrl;
      } catch (_) { /* El aviso inferior explica el caso sin acceso. */ }
    }
    if (!source) {
      previewInfo.textContent = `${name} · No se pudo obtener la ruta del archivo.`;
      return;
    }
    const imageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
    const audioExtensions = ["mp3", "wav", "m4a", "aac", "aif", "aiff", "ogg", "flac"];
    const isImage = imageExtensions.includes(extension);
    const isAudio = audioExtensions.includes(extension);
    // Para vídeo y audio usamos WebView: es el reproductor que Adobe expone
    // para contenidos embebidos y evita la pantalla negra de HTMLVideoElement
    // en determinados paneles acoplados de Premiere.
    // El audio directo conserva los controles de reproducción del panel. En
    // algunas versiones de UXP un WebView de audio no dibuja sus controles y
    // parece una vista previa muda.
    const useWebView = Boolean(playerSource) && !isImage && !isAudio;
    const media = makeElement(useWebView ? "webview" : isImage ? "img" : isAudio ? "audio" : "video");
    if (useWebView) {
      media.setAttribute("src", playerSource);
      media.setAttribute("uxpAllowInspector", "false");
      media.style.width = "100%";
      media.style.height = "100%";
      media.style.minHeight = "260px";
      media.style.border = "0";
      media.style.backgroundColor = "#0d0f12";
    } else {
      media.src = source;
      media.controls = false;
      media.preload = "auto";
      media.style.maxWidth = "100%";
      media.style.maxHeight = "100%";
      media.style.width = "100%";
      media.style.height = isImage ? "100%" : "auto";
      media.style.objectFit = "contain";
      if (media.tagName === "AUDIO") media.style.margin = "auto 0";
      if (media.tagName === "AUDIO") {
        media.style.display = "none";
      }
    }
    if (media.tagName !== "IMG" && media.tagName !== "WEBVIEW") {
      media.addEventListener("play", () => { playPause.textContent = "Pausar"; });
      media.addEventListener("pause", () => { playPause.textContent = "Reproducir"; });
    }
    media.addEventListener("error", () => {
      previewInfo.textContent = `${name} · La vista previa integrada no está disponible para este formato. Usa “Abrir en monitor de origen”.`;
    });
    previewMedia = media.tagName === "WEBVIEW" ? null : media;
    clear(previewStage);
    if (isAudio) await drawAudioWave(file, previewStage);
    previewStage.appendChild(media);
    if (media.tagName === "WEBVIEW") {
      previewControls.style.display = "none";
      previewInfo.textContent = `${name} · Vista previa lista. Usa los controles del reproductor.`;
    } else {
      previewControls.style.display = "flex";
      media.addEventListener("loadeddata", () => {
        previewInfo.textContent = `${name} · Vista previa lista.`;
      });
    }
    media.addEventListener("error", () => {
      previewInfo.textContent = `${name} · No se pudo reproducir este archivo en el panel.`;
    });
    if (typeof media.load === "function") media.load();
  };
  const findProjectItem = async (folder, nativePath, displayName) => {
    const items = await folder.getItems();
    for (const item of items) {
      try {
        const clip = ppro.ClipProjectItem.cast(item);
        const mediaPath = await clip.getMediaFilePath();
        if (String(mediaPath).toLowerCase() === String(nativePath).toLowerCase()) return item;
      } catch (_) {
        try {
          const subfolder = ppro.FolderItem.cast(item);
          const found = await findProjectItem(subfolder, nativePath, displayName);
          if (found) return found;
        } catch (_) {
          // No es un clip ni una carpeta recorrible.
        }
      }
    }
    return null;
  };
  const placeSelectedFile = async () => {
    if (!selectedFile) return;
    const nativePath = String(selectedFile.nativePath || "");
    if (!nativePath) throw new Error("No se pudo obtener la ruta del archivo seleccionado.");
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("Abre un proyecto de Premiere antes de colocar un archivo.");
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("Abre una secuencia y coloca el marcador donde quieras insertar el archivo.");
    const insertionBin = await project.getInsertionBin();
    // Project#getInsertionBin devuelve un ProjectItem; para recorrer sus
    // hijos hay que convertirlo explícitamente a FolderItem.
    const targetBin = ppro.FolderItem.cast(insertionBin);
    const imported = await project.importFiles([nativePath], true, targetBin, false);
    if (!imported) throw new Error("Premiere no pudo importar este archivo.");
    const projectItem = await findProjectItem(targetBin, nativePath, nameOf(selectedFile));
    if (!projectItem) throw new Error("El archivo se importó, pero Premiere aún no lo entregó para colocarlo. Inténtalo una vez más.");
    const marker = await sequence.getPlayerPosition();
    const extension = String(nameOf(selectedFile)).split(".").pop().toLowerCase();
    const audioOnly = ["mp3", "wav", "m4a", "aac", "aif", "aiff", "ogg", "flac"].includes(extension);
    const videoTrackIndex = audioOnly ? -1 : await findLowestAvailableTrack(sequence, "video", marker);
    const audioTrackIndex = await findLowestAvailableTrack(sequence, "audio", marker);
    const editor = ppro.SequenceEditor.getEditor(sequence);
    let inserted = false;
    project.lockedAccess(() => {
      inserted = project.executeTransaction((compoundAction) => {
        // Insertar desplaza y puede partir clips largos en las demás pistas.
        // Overwrite únicamente coloca el recurso sobre la pista libre elegida.
        compoundAction.addAction(editor.createOverwriteProjectItemAction(
          projectItem, marker, videoTrackIndex, audioTrackIndex
        ));
      }, "Biblioteca Gota: colocar archivo sin desplazar la edición");
    });
    if (!inserted) throw new Error("Premiere no pudo colocar el archivo en la primera pista disponible.");
    return sequence;
  };
  backFive.addEventListener("click", () => {
    if (previewMedia && Number.isFinite(previewMedia.currentTime)) previewMedia.currentTime = Math.max(0, previewMedia.currentTime - 5);
  });
  forwardFive.addEventListener("click", () => {
    if (previewMedia && Number.isFinite(previewMedia.currentTime)) previewMedia.currentTime = Math.min(previewMedia.duration || Infinity, previewMedia.currentTime + 5);
  });
  playPause.addEventListener("click", async () => {
    if (!previewMedia || previewMedia.tagName === "IMG") return;
    try {
      if (previewMedia.paused) await previewMedia.play(); else previewMedia.pause();
    } catch (error) {
      previewInfo.textContent = `No se pudo iniciar la reproducción: ${error.message || String(error)}`;
    }
  });
  sourceMonitor.addEventListener("click", async () => {
    if (!selectedFile) return;
    try {
      await ppro.SourceMonitor.openFilePath(selectedFile.nativePath);
    } catch (_) {
      previewInfo.textContent = "Premiere no pudo abrir este formato en el monitor de origen.";
    }
  });
  place.addEventListener("click", async () => {
    if (!selectedFile || place.style.opacity !== "1") return;
    place.textContent = "Añadiendo…";
    place.style.opacity = "0.7";
    place.style.cursor = "default";
    try {
      const sequence = await placeSelectedFile();
      previewInfo.textContent = `${nameOf(selectedFile)} · Añadido en ${sequence.name}, en pistas nuevas y sin sobrescribir tu edición.`;
    } catch (error) {
      previewInfo.textContent = `No se pudo añadir: ${error.message || String(error)}`;
    } finally {
      setPlaceEnabled(Boolean(selectedFile));
    }
  });
  const showSearchResults = async (query) => {
    const term = normalizeSearch(query);
    if (!term) return false;
    const generation = ++searchGeneration;
    selectedFile = null;
    clearPreview();
    setPlaceEnabled(false);
    previewInfo.textContent = "Selecciona un archivo para previsualizarlo.";
    clear(contents);
    const heading = makeElement("div", `Resultados para: “${query.trim()}”`);
    heading.style.fontWeight = "bold";
    heading.style.marginBottom = "7px";
    contents.appendChild(heading);
    const searching = makeElement("div", "Buscando en todas las carpetas enlazadas…");
    searching.style.fontSize = "10px";
    searching.style.color = "#a8b8c7";
    contents.appendChild(searching);
    const results = [];
    const walk = async (folder, rootName, parents) => {
      let entries = [];
      try { entries = await folder.getEntries(); } catch (_) { return; }
      for (const entry of entries) {
        if (generation !== searchGeneration) return;
        const entryName = nameOf(entry);
        const entryPath = parents.concat([entryName]);
        if (normalizeSearch(entryName).includes(term)) {
          results.push({ entry, path: [rootName].concat(entryPath) });
        }
        if (entry.isFolder) await walk(entry, rootName, entryPath);
      }
    };
    for (const root of roots) {
      if (generation !== searchGeneration) return true;
      try {
        const folder = await localFileSystem.getEntryForPersistentToken(root.token);
        if (folder && folder.isFolder) await walk(folder, nameOf(folder), []);
      } catch (_) { /* Una raíz desconectada no impide buscar en las demás. */ }
    }
    if (generation !== searchGeneration) return true;
    clear(contents);
    contents.appendChild(heading);
    const count = makeElement("div", `${results.length} resultado${results.length === 1 ? "" : "s"}.`);
    count.style.fontSize = "10px";
    count.style.color = "#a8a8a8";
    count.style.marginBottom = "7px";
    contents.appendChild(count);
    if (!results.length) {
      contents.appendChild(makeElement("div", "No encontré archivos ni carpetas con ese nombre."));
      return true;
    }
    results.sort((a, b) => pathLabel(a.path).localeCompare(pathLabel(b.path)));
    for (const result of results) {
      const item = makeElement("div", `${result.entry.isFolder ? "📁" : "📄"} ${nameOf(result.entry)}`);
      item.style.padding = "6px";
      item.style.marginBottom = "5px";
      item.style.borderRadius = "4px";
      item.style.backgroundColor = result.entry.isFolder ? "#20252b" : "#151515";
      item.style.cursor = "pointer";
      item.style.fontSize = "10px";
      item.title = pathLabel(result.path);
      const location = makeElement("div", pathLabel(result.path));
      location.style.fontSize = "9px";
      location.style.color = "#8a9aaa";
      location.style.marginTop = "3px";
      location.style.whiteSpace = "nowrap";
      location.style.overflow = "hidden";
      location.style.textOverflow = "ellipsis";
      item.appendChild(location);
      item.addEventListener("click", () => {
        if (result.entry.isFolder) showContents(result.entry, `search/${pathLabel(result.path)}`);
        else showPreview(result.entry);
      });
      contents.appendChild(item);
    }
    return true;
  };
  const showContents = async (folder, key) => {
    activeKey = key;
    selectedFile = null;
    clearPreview();
    setPlaceEnabled(false);
    previewInfo.textContent = "Selecciona un archivo para previsualizarlo.";
    clear(contents);
    const heading = makeElement("div", `Contenido: ${nameOf(folder)}`);
    heading.style.fontWeight = "bold";
    heading.style.marginBottom = "7px";
    contents.appendChild(heading);
    try {
      const entries = await folder.getEntries();
      const folders = entries.filter((entry) => entry.isFolder)
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      const files = entries.filter((entry) => entry.isFile)
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      const count = makeElement("div", `${folders.length} carpetas · ${files.length} archivos`);
      count.style.fontSize = "10px";
      count.style.color = "#a8a8a8";
      count.style.marginBottom = "7px";
      contents.appendChild(count);
      if (!entries.length) contents.appendChild(makeElement("div", "Esta carpeta está vacía."));
      for (const entry of folders.concat(files)) {
        const item = makeElement("div", `${entry.isFolder ? "📁" : "📄"} ${nameOf(entry)}`);
        item.style.padding = "6px";
        item.style.marginBottom = "5px";
        item.style.fontSize = "10px";
        item.style.borderRadius = "4px";
        item.style.backgroundColor = entry.isFolder ? "#20252b" : "#151515";
        item.style.whiteSpace = "nowrap";
        item.style.overflow = "hidden";
        item.style.textOverflow = "ellipsis";
        if (entry.isFolder) {
          item.style.cursor = "pointer";
          item.addEventListener("click", () => showContents(entry, `${key}/${nameOf(entry)}`));
        } else {
          item.style.cursor = "pointer";
          item.title = "Seleccionar y previsualizar este archivo";
          item.addEventListener("click", () => {
            Array.from(contents.children).forEach((child) => {
              if (child !== heading && child !== count) child.style.outline = "none";
            });
            item.style.outline = "2px solid #1473e6";
            showPreview(entry);
          });
        }
        contents.appendChild(item);
      }
    } catch (_) {
      const error = makeElement("div", "No se pudo leer esta carpeta. Revisa que siga conectada y vuelve a enlazarla si cambió el permiso.");
      error.style.color = "#ed8b8b";
      contents.appendChild(error);
    }
  };
  const appendTree = async (folder, key, depth, parent) => {
    const item = row(`▸ 📁 ${nameOf(folder)}`, depth);
    const children = makeElement("div");
    children.style.display = "none";
    let loaded = false;
    item.addEventListener("click", async () => {
      await showContents(folder, key);
      if (!loaded) {
        loaded = true;
        try {
          const folders = (await folder.getEntries()).filter((entry) => entry.isFolder)
            .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
          for (const child of folders) await appendTree(child, `${key}/${nameOf(child)}`, depth + 1, children);
        } catch (_) {
          children.appendChild(row("No se pudo leer", depth + 1));
        }
      }
      const open = children.style.display === "none";
      children.style.display = open ? "block" : "none";
      item.textContent = `${open ? "▾" : "▸"} 📁 ${nameOf(folder)}`;
    });
    parent.appendChild(item);
    parent.appendChild(children);
  };
  const render = async () => {
    clear(tree); clear(contents);
    // El contenido se vuelve a leer desde las rutas persistentes. Restablecer
    // la selección permite que Actualizar siempre deje una carpeta visible.
    activeKey = "";
    let available = 0;
    for (const root of roots) {
      try {
        const folder = await localFileSystem.getEntryForPersistentToken(root.token);
        if (!folder || !folder.isFolder) throw new Error("not-folder");
        available += 1;
        const wrapper = makeElement("div");
        wrapper.style.position = "relative";
        wrapper.style.display = "block";
        wrapper.style.minHeight = "27px";
        const remove = makeElement("div", "×");
        remove.style.position = "absolute";
        remove.style.top = "1px";
        remove.style.left = "0";
        remove.style.zIndex = "2";
        remove.style.padding = "5px 7px";
        remove.style.color = "#ed8b8b";
        remove.style.cursor = "pointer";
        remove.title = "Quitar esta carpeta de la biblioteca";
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          roots = roots.filter((item) => item.id !== root.id);
          saveRoots(); render();
        });
        tree.appendChild(wrapper);
        // La raíz se crea con una fila directa y visible. Las subcarpetas se
        // cargan al pulsar la raíz; así una biblioteca grande no bloquea el
        // panel ni deja una zona vacía mientras Premiere obtiene entradas.
        const rootRow = row(`▸ 📁 ${nameOf(folder)}`, 0);
        rootRow.style.paddingLeft = "25px";
        rootRow.addEventListener("click", async () => {
          await showContents(folder, root.id);
          const alreadyExpanded = wrapper.dataset.expanded === "true";
          const childHolder = wrapper.querySelector(".gck-library-children");
          if (alreadyExpanded) {
            if (childHolder) childHolder.style.display = "none";
            wrapper.dataset.expanded = "false";
            rootRow.textContent = `▸ 📁 ${nameOf(folder)}`;
            return;
          }
          let children = childHolder;
          if (!children) {
            children = makeElement("div");
            children.className = "gck-library-children";
            wrapper.appendChild(children);
            try {
              const folders = (await folder.getEntries())
                .filter((entry) => entry.isFolder)
                .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
              for (const child of folders) await appendTree(child, `${root.id}/${nameOf(child)}`, 1, children);
            } catch (_) {
              children.appendChild(row("No se pudo leer esta carpeta", 1));
            }
          }
          children.style.display = "block";
          wrapper.dataset.expanded = "true";
          rootRow.textContent = `▾ 📁 ${nameOf(folder)}`;
        });
        wrapper.appendChild(rootRow);
        wrapper.appendChild(remove);
        // Al abrir la Biblioteca por primera vez se muestra el contenido de
        // la primera raíz automáticamente; no obliga al usuario a adivinar
        // que debe pulsar el nombre de la carpeta.
        if (!activeKey) await showContents(folder, root.id);
      } catch (_) {
        const unavailable = row(`⚠ ${root.name || "Carpeta"} — vuelve a enlazarla`);
        unavailable.style.color = "#edc36f";
        tree.appendChild(unavailable);
      }
    }
    status.textContent = available
      ? `${available} carpeta${available === 1 ? "" : "s"} raíz disponible${available === 1 ? "" : "s"}.`
      : "Aún no hay carpetas enlazadas. Usa + Añadir carpeta.";
    if (normalizeSearch(search.value)) {
      await showSearchResults(search.value);
    } else if (!available) {
      contents.appendChild(makeElement("div", "Aquí aparecerán tus archivos y subcarpetas."));
    }
  };
  add.addEventListener("click", async () => {
    try {
      const folder = await localFileSystem.getFolder();
      if (!folder) return;
      const token = await localFileSystem.createPersistentToken(folder);
      if (!roots.some((root) => root.token === token)) {
        roots.push({ id: `root-${Date.now()}-${Math.random().toString(36).slice(2)}`, token, name: nameOf(folder) });
        saveRoots();
      }
      await render();
    } catch (_) {
      status.textContent = "No se pudo enlazar la carpeta. Acepta el permiso de Premiere e inténtalo otra vez.";
    }
  });
  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    const query = search.value;
    if (!normalizeSearch(query)) {
      searchGeneration += 1;
      render();
      return;
    }
    searchTimer = setTimeout(() => { showSearchResults(query); }, 180);
  });
  refresh.addEventListener("click", () => {
    searchGeneration += 1;
    render();
  });
  render();
  return panel;
}

let panelNode;
let libraryPanelNode;

entrypoints.setup({
  panels: {
    autoframeFacesPanel: {
      create(rootNode) {
        panelNode = buildPanel();
        rootNode.appendChild(panelNode);
      },
      show(rootNode) {
        if (!panelNode) panelNode = buildPanel();
        if (!rootNode.contains(panelNode)) rootNode.appendChild(panelNode);
      }
    },
    gckLibraryPanel: {
      create(rootNode) {
        libraryPanelNode = buildLibraryPanel();
        rootNode.appendChild(libraryPanelNode);
      },
      show(rootNode) {
        if (!libraryPanelNode) libraryPanelNode = buildLibraryPanel();
        if (!rootNode.contains(libraryPanelNode)) rootNode.appendChild(libraryPanelNode);
      }
    }
  }
});
