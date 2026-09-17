const BASE_URL = "http://127.0.0.1:8765";

async function analyzeClip(payload) {
  const response = await fetch(`${BASE_URL}/v1/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Servicio local: ${response.status} ${detail}`);
  }
  return response.json();
}

module.exports = { analyzeClip };
