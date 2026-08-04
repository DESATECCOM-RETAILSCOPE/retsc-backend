// OCR de un buffer de imagen vía Azure AI Vision — Image Analysis 4.0, feature "read".
// Réplica (reescrita, no copiada) del mismo llamado que usa Functions/src/lib/visionOcr.js
// (repo hermano, NO se toca) — mismo endpoint/api-version/feature, para que el texto
// extraído acá sea consistente con el que se usó para poblar retsc-sku-vectors.
//
// ⚠ ÚNICA diferencia deliberada con la Function: la Function manda `{ url: <blob firmado
// con SAS> }` porque ya tenía la URL del blob original y Vision no acepta blobs privados sin
// firmar. Acá el caller (scripts/run-ocr-embedding-validation.js) ya tiene el recorte como
// Buffer en memoria (descargado + cropeado con sharp) — se manda el buffer crudo
// (`Content-Type: application/octet-stream`), mismo patrón que ya usa customVisionService.js
// para subir imágenes a Custom Vision. Evita necesitar SAS-signing (que requeriría
// AzureWebJobsStorage, un patrón de acceso a blobs que este backend no usa) solo para este
// caso. El motor de OCR (Vision, misma versión/feature) es idéntico — el texto debería salir
// igual que si se le mandara una URL de la misma imagen.
//
// MANTENER SINCRONIZADO CON LA FUNCTION: mismo `api-version`/`features` — si cambian allá,
// replicar acá para que el texto siga siendo comparable.

function requireConfig() {
  const endpoint = process.env.AZURE_VISION_ENDPOINT;
  const key      = process.env.AZURE_VISION_KEY;
  if (!endpoint || !key) {
    throw new Error('Azure AI Vision no configurado — faltan AZURE_VISION_ENDPOINT/AZURE_VISION_KEY en .env.');
  }
  return { endpoint: endpoint.replace(/\/+$/, ''), key };
}

// Extrae el texto legible de una imagen (recorte de cajita). Devuelve el texto plano (todas
// las líneas detectadas, unidas con espacios — mismo criterio que visionOcr.js de la
// Function) y las dimensiones reportadas por Vision para la imagen recibida.
// Lanza si Azure Vision falla — el caller decide cómo degradar (ver el script de validación,
// que registra el fallo por-anotación sin romper la corrida completa).
async function runOcr(buffer) {
  const { endpoint, key } = requireConfig();
  const url = `${endpoint}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/octet-stream',
    },
    body: buffer,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Azure Vision HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = await resp.json();

  // Misma estructura que documenta visionOcr.js: readResult.blocks[].lines[].text —
  // un bloque por región de texto detectada, varias líneas cada uno. Se unen todas en un
  // solo string separado por espacios (no importa la posición/layout para la búsqueda).
  const blocks = data?.readResult?.blocks ?? [];
  const text = blocks
    .flatMap(b => b.lines?.map(l => l.text) ?? [])
    .join(' ')
    .trim();

  const width  = data?.metadata?.width  ?? 0;
  const height = data?.metadata?.height ?? 0;

  return { text, width, height };
}

module.exports = { runOcr };
