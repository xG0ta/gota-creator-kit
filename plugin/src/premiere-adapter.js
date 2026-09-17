const ppro = require("premierepro");

async function getSelectedVideoClips() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No hay un proyecto activo.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No hay una secuencia activa.");

  const selection = await sequence.getSelection();
  const selected = await selection.getTrackItems();
  const clips = [];

  for (const trackItem of selected) {
    if (typeof trackItem.getComponentChain !== "function") continue;
    const projectItem = await trackItem.getProjectItem();
    let clipProjectItem;
    try {
      clipProjectItem = ppro.ClipProjectItem.cast(projectItem);
    } catch (_) {
      continue;
    }
    const mediaPath = await clipProjectItem.getMediaFilePath();
    if (!mediaPath) continue;
    clips.push({
      trackItem,
      clipProjectItem,
      mediaPath,
      name: await trackItem.getName(),
      isMulticam: await clipProjectItem.isMulticamClip()
    });
  }
  return { project, sequence, clips };
}

/*
 * Próximo hito:
 * - descubrir el componente Motion por matchName;
 * - mapear Anchor Point, Position y Scale sin depender del idioma;
 * - crear SetTimeVarying/AddKeyframe actions;
 * - añadirlas a project.executeTransaction(...);
 * - operar sobre una secuencia clonada.
 */
async function applyPlan() {
  throw new Error("Aplicación desactivada hasta validar Motion en Premiere real.");
}

module.exports = { getSelectedVideoClips, applyPlan };
