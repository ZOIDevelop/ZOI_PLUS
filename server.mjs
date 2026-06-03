import http from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const sampleCsvPath = path.join(__dirname, "data", "products.sample.csv");
const backupDir = path.join(__dirname, "data", "backups");
const envPath = path.join(__dirname, ".env");
const backupTtlMs = 48 * 60 * 60 * 1000;
const backupHeaders = [
  "id",
  "type",
  "created_at",
  "expires_at",
  "customer_name",
  "whatsapp",
  "email",
  "city",
  "item_count",
  "subtotal",
  "status",
  "n8n_status",
  "payload_json"
];

loadDotEnv(envPath);
cleanupExpiredBackups().catch((error) => console.error("Could not clean local backups", error));

const port = Number(process.env.PORT || 4173);
const productCache = { value: null, expiresAt: 0 };
const cacheMs = 30_000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/products") {
      return json(res, 200, await getProducts());
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      return json(res, 200, {
        googleClientId: process.env.GOOGLE_CLIENT_ID || "",
        paypalReceiverEmail: process.env.PAYPAL_RECEIVER_EMAIL || "info@zoi.ec"
      });
    }

    if (req.method === "POST" && url.pathname === "/api/orders") {
      return handleWebhookRequest(req, res, "order", process.env.N8N_ORDER_WEBHOOK_URL, {
        fallbackPaymentUrl: process.env.PAYMENT_CHECKOUT_URL
      });
    }

    if (req.method === "POST" && url.pathname === "/api/quotes") {
      return handleWebhookRequest(req, res, "quote", process.env.N8N_QUOTE_WEBHOOK_URL);
    }

    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: "Unexpected server error" });
  }
});

server.listen(port, () => {
  console.log(`ZOI PLUS e-commerce running at http://localhost:${port}`);
});

async function getProducts() {
  if (productCache.value && Date.now() < productCache.expiresAt) {
    return productCache.value;
  }

  const csv = await fetchInventoryCsv();
  const rows = parseCsv(csv);
  const products = rows
    .map(normalizeProduct)
    .filter((product) => product.visible && product.stock > 0 && product.name)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  const categories = [...new Set(products.map((product) => product.category).filter(Boolean))].sort();
  const tags = [...new Set(products.flatMap((product) => product.tags))].sort();

  const payload = {
    ok: true,
    source: process.env.GOOGLE_SHEET_CSV_URL || process.env.GOOGLE_SHEET_ID ? "google-sheets" : "sample",
    products,
    categories,
    tags,
    updatedAt: new Date().toISOString()
  };

  productCache.value = payload;
  productCache.expiresAt = Date.now() + cacheMs;
  return payload;
}

async function fetchInventoryCsv() {
  const directUrl = process.env.GOOGLE_SHEET_CSV_URL?.trim();
  const sheetId = process.env.GOOGLE_SHEET_ID?.trim();
  const gid = process.env.GOOGLE_SHEET_GID?.trim() || "0";
  const url = directUrl || (sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}` : "");

  if (!url) {
    return readFile(sampleCsvPath, "utf8");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load Google Sheet CSV: ${response.status}`);
  }
  return response.text();
}

function normalizeProduct(row) {
  return {
    sku: value(row.sku),
    name: value(row.nombre),
    category: value(row.categoria) || "General",
    tags: value(row.tags)
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    description: value(row.descripcion),
    price: Number.parseFloat(value(row.precio).replace(",", ".")) || 0,
    stock: Number.parseInt(value(row.stock), 10) || 0,
    imageUrl: value(row.foto_url),
    visible: ["true", "1", "yes", "si", "sí", "visible"].includes(value(row.visible).toLowerCase()),
    order: Number.parseInt(value(row.orden), 10) || 9999
  };
}

async function handleWebhookRequest(req, res, type, webhookUrl, options = {}) {
  const body = await readJsonBody(req);
  const orderId = `${type.toUpperCase()}-${Date.now()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
  const receivedAt = new Date().toISOString();
  const payload = {
    ...body,
    id: orderId,
    [type === "order" ? "order_id" : "quote_id"]: orderId,
    source: "zoi-plus-ecommerce",
    receivedAt
  };
  await cleanupExpiredBackups();
  await upsertBackupRow(type, payload, "received", webhookUrl ? "pending" : "not_configured");

  if (!webhookUrl) {
    return json(res, 200, {
      ok: true,
      simulated: true,
      id: orderId,
      paymentUrl: type === "order" ? options.fallbackPaymentUrl || "" : "",
      message: `${type} captured locally. Configure n8n webhook URL to forward it.`
    });
  }

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    await upsertBackupRow(type, payload, "received", "failed");
    return json(res, 502, { ok: false, id: orderId, error: "Could not reach n8n webhook" });
  }

  if (!response.ok) {
    await upsertBackupRow(type, payload, "received", "failed");
    return json(res, 502, { ok: false, id: orderId, error: "n8n webhook rejected the request" });
  }

  const result = await readWebhookResponse(response);
  await upsertBackupRow(type, payload, "received", "sent");

  return json(res, 200, {
    ok: true,
    id: orderId,
    paymentUrl: type === "order" ? findPaymentUrl(result) || options.fallbackPaymentUrl || "" : "",
    webhook: result
  });
}

async function readWebhookResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function findPaymentUrl(input) {
  if (!input || typeof input !== "object") return "";
  const candidates = [
    input.payment_url,
    input.paymentUrl,
    input.checkout_url,
    input.checkoutUrl,
    input.url,
    input.data?.payment_url,
    input.data?.paymentUrl,
    input.data?.checkout_url,
    input.data?.checkoutUrl,
    input.data?.url
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.startsWith("http")) || "";
}

async function upsertBackupRow(type, payload, status, n8nStatus) {
  await ensureBackupFile(type);
  const filePath = getBackupPath(type);
  const rows = parseCsv(await readFile(filePath, "utf8"));
  const existingIndex = rows.findIndex((row) => row.id === payload.id);
  const row = buildBackupRow(type, payload, status, n8nStatus);
  if (existingIndex >= 0) rows[existingIndex] = row;
  else rows.push(row);
  await writeCsvRows(filePath, rows);
}

function buildBackupRow(type, payload, status, n8nStatus) {
  const createdAt = payload.receivedAt || new Date().toISOString();
  const expiresAt = new Date(new Date(createdAt).getTime() + backupTtlMs).toISOString();
  const customer = type === "order" ? payload.customer || {} : payload.quote || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const subtotal = type === "order" ? payload.totals?.subtotal || 0 : "";
  return {
    id: payload.id,
    type,
    created_at: createdAt,
    expires_at: expiresAt,
    customer_name: value(customer.nombre || customer.name),
    whatsapp: value(customer.whatsapp),
    email: value(customer.email || customer.emailOptional),
    city: value(customer.ciudad || customer.city || customer.pais_ciudad),
    item_count: String(items.reduce((total, item) => total + (Number(item.quantity) || 1), 0)),
    subtotal: String(subtotal),
    status,
    n8n_status: n8nStatus,
    payload_json: JSON.stringify(payload)
  };
}

async function cleanupExpiredBackups() {
  await mkdir(backupDir, { recursive: true });
  await Promise.all(["order", "quote"].map(async (type) => {
    await ensureBackupFile(type);
    const filePath = getBackupPath(type);
    const rows = parseCsv(await readFile(filePath, "utf8"));
    const now = Date.now();
    const activeRows = rows.filter((row) => {
      const expiresAt = Date.parse(row.expires_at);
      return Number.isNaN(expiresAt) || expiresAt > now;
    });
    if (activeRows.length !== rows.length) await writeCsvRows(filePath, activeRows);
  }));
}

async function ensureBackupFile(type) {
  await mkdir(backupDir, { recursive: true });
  const filePath = getBackupPath(type);
  if (!existsSync(filePath)) {
    await writeFile(filePath, `${backupHeaders.join(",")}\n`, "utf8");
  }
}

function getBackupPath(type) {
  return path.join(backupDir, type === "order" ? "orders.csv" : "quotes.csv");
}

async function writeCsvRows(filePath, rows) {
  const csv = [backupHeaders.join(","), ...rows.map((row) => backupHeaders.map((header) => csvCell(row[header])).join(","))].join("\n") + "\n";
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, csv, "utf8");
  await rename(tempPath, filePath);
}

function csvCell(input) {
  const text = value(input);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, cleanPath));

  if (!filePath.startsWith(publicDir)) {
    return json(res, 403, { ok: false, error: "Forbidden" });
  }

  const target = existsSync(filePath) ? filePath : path.join(publicDir, "index.html");
  const ext = path.extname(target);
  const body = await readFile(target);
  res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream" });
  res.end(body);
}

function parseCsv(csv) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    const next = csv[i + 1];

    if (char === "\"" && inQuotes && next === "\"") {
      field += "\"";
      i += 1;
    } else if (char === "\"") {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift()?.map((header) => header.trim()) || [];
  return rows
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""])));
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function value(input) {
  return String(input ?? "").trim();
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").trim();
  }
}
