#!/usr/bin/env bash
# =============================================================================
# pruebas_adm_paso6.sh — Pruebas del paso 6 (cuentas por cobrar, notas de cobro, bitácora y
# guardia de moneda en contratos) contra el backend en QA.
#
# QUÉ HACE: lanza peticiones con curl y compara el código HTTP (y algunos valores de la
# respuesta) con lo esperado. Imprime PASA / FALLA por cada una.
#
# ADVERTENCIA: estas pruebas ESCRIBEN datos reales en las tablas RETSC_ADM_* de QA (una
# factura, una nota de cobro y filas de bitácora). No hacen rollback. Úsalas SOLO contra QA y
# con una empresa de prueba. Los números de factura y las notas empiezan con PRUEBA.
#
# REQUISITOS: curl y node (node se usa para leer el JSON de las respuestas y calcular fechas;
# no se necesita jq). El backend debe estar corriendo apuntando a la base de QA.
#
# USO (variables de entorno, sin guardarlas en ningún archivo):
#   BASE=http://localhost:3000 \
#   DTC_TOKEN='<token de un usuario ADMIN_DTC>' \
#   CLIENT_TOKEN='<token de un ADMIN o GERENCIA de la empresa de prueba>' \
#   ENT_ID=<Enterprise_id de la empresa de prueba> \
#   OTHER_ENT_ID=<Enterprise_id de OTRA empresa> \
#   CONTRACT_ID=<Contract_id del contrato de prueba> \
#   ./pruebas_adm_paso6.sh
#
# IMPORTANTE:
#   - CLIENT_TOKEN debe pertenecer a un usuario de la empresa ENT_ID.
#   - CONTRACT_ID debe ser un contrato ACTIVO de ENT_ID, en USD, con método OC_FACTURA,
#     30 días de crédito y SIN exigir OC (el mismo de pruebas_adm_paso5.sh).
#   - El script registra al inicio una factura vencida (emitida hace 100 días) para tener un
#     caso de saldo vencido y para que el contrato tenga facturas (guardia de moneda).
#   - La prueba del guardia intenta cambiar la moneda del contrato a CRC. Si el guardia
#     fallara y el cambio se aplicara, el script la devuelve a USD de inmediato.
#   - Se puede repetir: cada ejecución usa un número de factura nuevo (PRUEBA-<fecha y hora>-V).
# =============================================================================

# Falla si falta alguna variable obligatoria (la sintaxis ${VAR:?msg} aborta con el mensaje)
: "${BASE:?Falta BASE (ej. http://localhost:3000)}"
: "${DTC_TOKEN:?Falta DTC_TOKEN}"
: "${CLIENT_TOKEN:?Falta CLIENT_TOKEN}"
: "${ENT_ID:?Falta ENT_ID}"
: "${OTHER_ENT_ID:?Falta OTHER_ENT_ID}"
: "${CONTRACT_ID:?Falta CONTRACT_ID}"

PASAN=0
FALLAN=0
TMP="$(mktemp)"          # cuerpo de la última respuesta
HDR="$(mktemp)"          # cabeceras HTTP de la última respuesta
trap 'rm -f "$TMP" "$HDR"' EXIT   # se borran al terminar, pase lo que pase

# probar <nombre> <código(s) esperado(s), ej. 200 o 200|201> <método> <ruta> <token o "-"> [cuerpo JSON]
# (misma función que pruebas_adm_paso5.sh; además guarda las cabeceras en $HDR con -D)
probar() {
  local nombre="$1" esperado="$2" metodo="$3" ruta="$4" token="$5" cuerpo="${6:-}"
  # Argumentos de curl: -s silencioso, -o guarda el cuerpo, -D las cabeceras, -w imprime el código HTTP
  local args=(-s -o "$TMP" -D "$HDR" -w '%{http_code}' -X "$metodo" "$BASE$ruta")
  # Solo se manda el header de autorización si hay token ("-" significa "sin token")
  if [ "$token" != "-" ]; then args+=(-H "Authorization: Bearer $token"); fi
  # Solo se manda cuerpo si se indicó uno
  if [ -n "$cuerpo" ]; then args+=(-H 'Content-Type: application/json' -d "$cuerpo"); fi

  local codigo
  codigo="$(curl "${args[@]}")"

  # "esperado" puede traer varios códigos separados por | (ej. 200|201). Se rodea con | a ambos
  # lados para comparar códigos completos y no pedazos (así 20 no coincide con 200).
  if [[ "|$esperado|" == *"|$codigo|"* ]]; then
    echo "PASA   [$codigo] $nombre"; PASAN=$((PASAN + 1))
  else
    echo "FALLA  [$codigo, esperaba $esperado] $nombre"; FALLAN=$((FALLAN + 1))
  fi
  echo "       $(head -c 300 "$TMP")"   # primeros 300 caracteres de la respuesta
  echo
}

# campo <expresión> — lee un valor del JSON de la ÚLTIMA respuesta (guardada en $TMP).
# La expresión se aplica sobre el objeto "r", por ejemplo: campo 'r.invoice.invoiceId'.
# Si la respuesta no es JSON o el campo no existe, imprime vacío (y la comprobación falla).
campo() {
  node -pe "try { const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); String(($1) ?? '') } catch { '' }" -- "$TMP"
}

# verificar <nombre> <esperado> <obtenido> — compara dos textos y cuenta PASA / FALLA.
verificar() {
  if [ "$2" == "$3" ]; then
    echo "PASA   $1 (= $3)"; PASAN=$((PASAN + 1))
  else
    echo "FALLA  $1 (esperaba '$2', se obtuvo '$3')"; FALLAN=$((FALLAN + 1))
  fi
  echo
}

# fecha <días> — "hoy" en hora de Costa Rica (UTC-6, sin horario de verano) más N días, AAAA-MM-DD.
fecha() {
  node -pe "new Date(Date.now() - 6 * 3600e3 + Number(process.argv[1]) * 864e5).toISOString().slice(0, 10)" -- "$1"
}

HOY_MENOS_100="$(fecha -100)"
AYER="$(fecha -1)"
SELLO="$(date +%Y%m%d%H%M%S)"
NUM_V="PRUEBA-$SELLO-V"
NOTA_TEXTO="PRUEBA paso 6 $SELLO: se llamó a cuentas por pagar"
# Id de factura que no existe (cabe en un int de SQL Server, que llega a 2147483647).
FACTURA_INEXISTENTE=2147483000

echo "=== Preparación: factura vencida con saldo (emitida hoy-100, vence hoy-70) ==="
probar "DTC registra la factura vencida -> 201" 201 POST "/api/adm/invoices" "$DTC_TOKEN" \
  "{\"contractId\":$CONTRACT_ID,\"invoiceNumber\":\"$NUM_V\",\"issueDate\":\"$HOY_MENOS_100\",\"subtotal\":1000,\"taxAmount\":130,\"totalAmount\":1130,\"currency\":\"USD\"}"
INVOICE_V="$(campo 'r.invoice.invoiceId')"
verificar "Se obtuvo el id de la factura vencida" "true" "$(campo 'Number.isInteger(r.invoice.invoiceId)')"

echo "=== Antigüedad de saldos ==="
probar "DTC pide aging -> 200"                              200 GET "/api/adm/aging" "$DTC_TOKEN"
verificar "Aging trae la empresa ENT_ID en USD" "true" "$(campo "r.aging.some((a) => a.enterpriseId === $ENT_ID && a.currency === 'USD')")"

probar "DTC pide aging de OTRA empresa (?enterpriseId=) -> 200" 200 GET "/api/adm/aging?enterpriseId=$OTHER_ENT_ID" "$DTC_TOKEN"
verificar "El filtro por empresa no trae filas de ENT_ID" "true" "$(campo "r.aging.every((a) => a.enterpriseId === $OTHER_ENT_ID)")"

probar "DTC exporta aging a CSV -> 200"                     200 GET "/api/adm/aging?export=csv" "$DTC_TOKEN"
verificar "Content-Type del CSV" "text/csv; charset=utf-8" "$(grep -i '^content-type:' "$HDR" | head -1 | cut -d' ' -f2- | tr -d '\r')"
verificar "Content-Disposition trae el nombre del archivo" "true" "$(grep -qi '^content-disposition: attachment; filename="cuentas-por-cobrar-' "$HDR" && echo true || echo false)"
verificar "El CSV empieza con el BOM UTF-8 (ef bb bf)" "efbbbf" "$(head -c 3 "$TMP" | od -An -tx1 | tr -d ' \n')"
# Formato del dashboard (src/utils/csvExport.js): separador ";" y coma decimal con 2 decimales.
verificar "Primera línea del CSV = cabeceras separadas por ;" \
  "ID empresa;Empresa;Moneda;Vigente;Vencido 1 a 30 días;Vencido 31 a 60 días;Vencido 61 a 90 días;Vencido más de 90 días;Saldo total;Facturas con saldo" \
  "$(head -1 "$TMP" | sed $'s/^\xEF\xBB\xBF//' | tr -d '\r')"
# Fila de ENT_ID en USD: debe tener 10 campos separados por ";" y montos con coma y 2 decimales
# (por ejemplo 1130,00). Se busca la línea que empieza con "ENT_ID;" y termina la moneda en USD.
FILA_CSV="$(grep -a "^$ENT_ID;.*;USD;" "$TMP" | head -1 | tr -d '\r')"
verificar "El CSV trae la fila de ENT_ID en USD" "true" "$([ -n "$FILA_CSV" ] && echo true || echo false)"
verificar "Esa fila tiene 10 campos separados por ;" "10" "$(printf '%s' "$FILA_CSV" | awk -F';' '{print NF}')"
verificar "Saldo total con coma decimal y 2 decimales" "true" "$(printf '%s' "$FILA_CSV" | awk -F';' '{print ($9 ~ /^-?[0-9]+,[0-9][0-9]$/) ? "true" : "false"}')"

echo "=== Cuentas por cobrar ==="
probar "DTC lista vencidas (?filter=overdue) -> 200"        200 GET "/api/adm/receivables?enterpriseId=$ENT_ID&filter=overdue" "$DTC_TOKEN"
verificar "La factura vencida con saldo aparece en ?filter=overdue" "true" "$(campo "r.receivables.some((x) => x.invoiceId === $INVOICE_V && x.overdue === 1 && x.balance > 0)")"

echo "=== Notas de seguimiento ==="
probar "DTC crea nota con próximo contacto AYER -> 201"     201 POST "/api/adm/invoices/$INVOICE_V/notes" "$DTC_TOKEN" \
  "{\"note\":\"$NOTA_TEXTO\",\"nextContactDate\":\"$AYER\"}"
verificar "La nota guarda la fecha de próximo contacto" "$AYER" "$(campo 'r.note.nextContactDate')"

probar "DTC lista las notas de la factura -> 200"           200 GET "/api/adm/invoices/$INVOICE_V/notes" "$DTC_TOKEN"
verificar "La nota recién creada es la primera (más reciente)" "$NOTA_TEXTO" "$(campo 'r.notes[0].note')"

probar "Receivables tras la nota -> 200"                    200 GET "/api/adm/receivables?enterpriseId=$ENT_ID" "$DTC_TOKEN"
verificar "La factura queda marcada followUpDue" "1" "$(campo "r.receivables.find((x) => x.invoiceId === $INVOICE_V)?.followUpDue")"
verificar "Receivables trae la última nota" "$NOTA_TEXTO" "$(campo "r.receivables.find((x) => x.invoiceId === $INVOICE_V)?.lastNote")"
verificar "Las facturas con followUpDue van primero" "true" "$(campo "r.receivables.every((x, i, a) => i === 0 || a[i - 1].followUpDue >= x.followUpDue)")"

probar "Receivables ?filter=followUp -> 200"                200 GET "/api/adm/receivables?enterpriseId=$ENT_ID&filter=followUp" "$DTC_TOKEN"
verificar "?filter=followUp devuelve la factura" "true" "$(campo "r.receivables.some((x) => x.invoiceId === $INVOICE_V)")"
verificar "?filter=followUp solo trae followUpDue = 1" "true" "$(campo "r.receivables.every((x) => x.followUpDue === 1)")"

probar "Notas de una factura inexistente -> 404"            404 GET "/api/adm/invoices/$FACTURA_INEXISTENTE/notes" "$DTC_TOKEN"
probar "Nota a una factura inexistente -> 404"              404 POST "/api/adm/invoices/$FACTURA_INEXISTENTE/notes" "$DTC_TOKEN" '{"note":"PRUEBA no debe guardarse"}'

echo "=== Bitácora ==="
probar "Audit ?entityType=INVOICE -> 200"                   200 GET "/api/adm/audit?entityType=INVOICE" "$DTC_TOKEN"
verificar "Audit trae solo entidades INVOICE" "true" "$(campo "r.entries.length > 0 && r.entries.every((e) => e.entityType === 'INVOICE')")"
probar "Audit ?entityType=NOTE -> 422"                      422 GET "/api/adm/audit?entityType=NOTE" "$DTC_TOKEN"
verificar "El 422 marca entityType" "entityType" "$(campo 'r.field')"

probar "Audit ?limit=1 -> 200"                              200 GET "/api/adm/audit?limit=1" "$DTC_TOKEN"
verificar "?limit=1 devuelve una sola fila" "1" "$(campo 'r.entries.length')"
PRIMER_ID="$(campo 'r.entries[0].auditId')"
probar "Audit ?limit=1&beforeId=<anterior> -> 200"          200 GET "/api/adm/audit?limit=1&beforeId=$PRIMER_ID" "$DTC_TOKEN"
verificar "La página siguiente trae una fila" "1" "$(campo 'r.entries.length')"
verificar "La fila siguiente es distinta y anterior" "true" "$(campo "r.entries[0].auditId < $PRIMER_ID")"

echo "=== Guardia: moneda de un contrato con facturas ==="
probar "Cambiar la moneda del contrato con facturas -> 422" 422 PUT "/api/adm/contracts/$CONTRACT_ID" "$DTC_TOKEN" '{"currency":"CRC"}'
verificar "El 422 marca currency" "currency" "$(campo 'r.field')"
# Red de seguridad: si el guardia fallara y la moneda cambiara, se devuelve a USD.
if [ "$(campo 'r.contract.currency')" == "CRC" ]; then
  echo "AVISO  el guardia NO funcionó: devolviendo la moneda del contrato a USD"
  curl -s -o /dev/null -X PUT "$BASE/api/adm/contracts/$CONTRACT_ID" \
    -H "Authorization: Bearer $DTC_TOKEN" -H 'Content-Type: application/json' -d '{"currency":"USD"}'
fi

echo "=== El cliente no entra a las pantallas de DTC (403) ==="
probar "Cliente en aging -> 403"                            403 GET  "/api/adm/aging" "$CLIENT_TOKEN"
probar "Cliente en receivables -> 403"                      403 GET  "/api/adm/receivables" "$CLIENT_TOKEN"
probar "Cliente lista notas -> 403"                         403 GET  "/api/adm/invoices/$INVOICE_V/notes" "$CLIENT_TOKEN"
probar "Cliente crea nota -> 403"                           403 POST "/api/adm/invoices/$INVOICE_V/notes" "$CLIENT_TOKEN" '{"note":"PRUEBA no debe guardarse"}'
probar "Cliente en audit -> 403"                            403 GET  "/api/adm/audit" "$CLIENT_TOKEN"

echo "============================================================"
echo "Resumen: $PASAN pasan, $FALLAN fallan"
echo "============================================================"
[ "$FALLAN" -eq 0 ]   # el script termina con éxito solo si no hubo fallos
