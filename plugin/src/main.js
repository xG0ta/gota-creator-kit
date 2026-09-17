const { entrypoints } = require("uxp");
const { getSelectedVideoClips } = require("./premiere-adapter");
const { analyzeClip } = require("./service-client");

const panel = document.querySelector("#autoframe-panel");
const status = document.querySelector("#status");
const progress = document.querySelector("#progress");
const analyzeButton = document.querySelector("#analyze");

entrypoints.setup({
  panels: {
    autoframeFacesPanel: {
      create(rootNode) {
        rootNode.appendChild(panel);
      },
      show(rootNode) {
        if (!rootNode.contains(panel)) rootNode.appendChild(panel);
      }
    }
  }
});

function setStatus(message) {
  status.textContent = message;
}

analyzeButton.addEventListener("click", async () => {
  analyzeButton.disabled = true;
  progress.value = 0;
  try {
    const { clips } = await getSelectedVideoClips();
    if (!clips.length) throw new Error("Selecciona al menos un clip de video local.");

    const summaries = [];
    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index];
      setStatus(`Analizando ${index + 1}/${clips.length}: ${clip.name}`);
      const result = await analyzeClip({
        version: "1.0",
        mediaPath: clip.mediaPath,
        targetAspect: Number(document.querySelector("#aspect").value),
        sampleFps: Number(document.querySelector("#sampleFps").value),
        margin: Number(document.querySelector("#margin").value),
        smoothing: Number(document.querySelector("#smoothing").value),
        startSeconds: 0,
        endSeconds: null
      });
      summaries.push(
        `${clip.name}${clip.isMulticam ? " [multicámara]" : ""}: ` +
        `${result.keyframes.length} keyframes, confianza ${result.meanConfidence.toFixed(2)}`
      );
      progress.value = (index + 1) / clips.length;
    }
    setStatus(`Plan listo (sin aplicar)\n\n${summaries.join("\n")}`);
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    analyzeButton.disabled = false;
  }
});
