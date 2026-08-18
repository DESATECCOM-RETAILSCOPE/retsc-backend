// Genera el embedding de un texto vía Azure OpenAI (deployment ada-002) — réplica del mismo
// llamado que usa Functions/src/lib/openaiEmbedding.js (repo hermano, NO se toca desde acá)
// para que los vectores generados acá sean comparables contra los ya indexados en
// retsc-sku-vectors por esa Function. Reescrito en el estilo de este backend, no copiado
// del archivo original.
//
// ⚠ MANTENER SINCRONIZADO CON LA FUNCTION: mismo endpoint/deployment/api-version/modelo de
// embeddings. Si el modelo cambia allá (ej. a un deployment de más dimensiones), hay que
// replicar el cambio acá — de lo contrario los vectores que genera este backend para buscar
// dejan de ser comparables (coseno) contra los que ya están indexados.
//
// NOTA sobre batching: la API de embeddings de Azure OpenAI acepta `input` como un array de
// strings en una sola llamada HTTP. Deliberadamente NO se usa acá: un fallo de esa única
// llamada (red, un texto que exceda el límite de tokens del deployment) tumbaría el lote
// entero sin forma de distinguir cuál texto lo causó. `skuSearchService.buscarSkuPorTexto`
// necesita aislar el fallo a un solo ítem del arreglo (regla dura del entregable) sin afectar
// a los demás — por eso expone `embedText()` de a uno, y la eficiencia frente a "muchas
// cajitas por foto" se logra en skuSearchService con llamadas CONCURRENTES (no en serie),
// no empaquetando todo en una request.

function requireConfig() {
  const endpoint   = process.env.AZURE_OPENAI_ENDPOINT;
  const key        = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;

  if (!endpoint || !key || !deployment) {
    throw new Error(
      'Azure OpenAI no configurado — faltan AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_KEY/' +
      'AZURE_OPENAI_EMBEDDING_DEPLOYMENT en .env (ver .env.example).'
    );
  }
  return { endpoint: endpoint.replace(/\/+$/, ''), key, deployment };
}

// Devuelve el vector de 1536 floats (ada-002) del texto dado.
// Lanza si falta config o si la llamada a Azure OpenAI falla — no hay fallback silencioso
// (un vector vacío/inventado produciría matches falsos sin ningún error visible). El caller
// decide cómo degradar por-item (ver skuSearchService.js).
async function embedText(text) {
  const { endpoint, key, deployment } = requireConfig();
  const url = `${endpoint}/openai/deployments/${deployment}/embeddings?api-version=2023-05-15`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Azure OpenAI embeddings HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = await resp.json();
  // Misma forma de respuesta que la API de OpenAI/Azure OpenAI: { data: [{ embedding: [...] }] }
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error('Azure OpenAI embeddings: la respuesta no trajo un vector.');
  }
  return vector;
}

module.exports = { embedText };
