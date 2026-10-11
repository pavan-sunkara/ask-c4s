/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

// ============================================================================
// ECC PRICING CONNECTOR — SCAFFOLD (v0.27.78 → v0.27.79)
// ============================================================================
// WHY THIS EXISTS
//   Spare-part prices live in the SAP ECC backend, not in C4C. Confirmed by
//   probing the my340573 tenant: the C4C OData API exposes NO per-product
//   price (Product master has only a cost CATEGORY; ServiceRequestItem has no
//   amount fields; the internal price list is empty; CustomerOrderItem has
//   NetPriceAmount but ProductID isn't filterable; ContractItem is filterable
//   but the PM spares have 0 lines). $metadata has 52 FunctionImports, none
//   for external pricing — so there's no read-only OData "price this product"
//   call either.
//
//   C4S gets prices via the named integration "Request Sales Document Data
//   from SAP Business Suite" — a SOAP service on SAP Cloud Integration (CPI /
//   iflmap) that bridges C4C → ERP and returns external sales-document data
//   (pricing). The endpoint + auth (client certificate / mutual TLS) are
//   provided via env; this module calls it directly.
//
// STATUS: SCAFFOLD. The mTLS TRANSPORT below is real (postSoap()). What is NOT
//   yet wired — the two CONTENT pieces that need the message contract:
//     1. buildSoapRequest()  — the CustomerQuoteRequestExternalSalesDocumentData
//        request envelope. Returns null until a sample envelope is supplied.
//     2. parseSoapPrice()    — pull net price + currency out of the response.
//   Until both are filled, every lookup returns { priced:false, reason:"…" }
//   and the Prep-for-PM Price column shows "—". Nothing else is affected.
//
// CONFIG (.env — the shim loads .env at startup, same as C4C_*):
//   ECC_PRICING_ENABLED=true
//   ECC_PRICING_URL=https://l5459-iflmap.hcisbp.us2.hana.ondemand.com:443/cxf/COD/ERP/CUSTOMERQUOTEREQUESTEXTERNALSALESDOCUMENTDATAOUT?sap-client=100
//   ECC_PRICING_SOAP_ACTION=                      # SOAPAction header, if the iflow requires one
//   # Client certificate (mutual TLS) — EITHER a PEM cert+key pair …
//   ECC_PRICING_CLIENT_CERT=C:\\path\\to\\client.crt.pem
//   ECC_PRICING_CLIENT_KEY=C:\\path\\to\\client.key.pem
//   # … OR a PKCS#12 bundle:
//   ECC_PRICING_PFX=C:\\path\\to\\client.p12
//   ECC_PRICING_CERT_PASSPHRASE=...               # key/pfx passphrase, if any
//   ECC_PRICING_SERVER_CA=C:\\path\\to\\ca.pem     # optional; else system CA (--use-system-ca)
//   # Sales-area defaults used to build the request (ctx can override per call):
//   ECC_PRICING_SALES_ORG=...
//   ECC_PRICING_DISTR_CHANNEL=...
//   ECC_PRICING_DIVISION=...
//   ECC_PRICING_CURRENCY=USD
// ============================================================================

import https from "node:https";
import { readFileSync } from "node:fs";

export type EccPricingConfig = {
  enabled: boolean;
  url: string; // full CPI SOAP endpoint (incl. ?sap-client=…)
  soapAction: string;
  // mutual-TLS client cert: PEM pair OR PKCS#12 bundle.
  certPath: string;
  keyPath: string;
  pfxPath: string;
  passphrase: string;
  caPath: string;
  // sales-area defaults for the pricing request.
  salesOrg: string;
  distributionChannel: string;
  division: string;
  currency: string;
};

export type PricingContext = {
  customerId?: string;
  salesOrg?: string;
  distributionChannel?: string;
  division?: string;
  currency?: string;
  quantity?: number;
  pricingDate?: string; // ISO 8601
};

export type ProductPrice = {
  productId: string;
  priced: boolean;
  amount?: number;
  currency?: string;
  priceUnit?: number; // price is per this many base units (default 1)
  uom?: string;
  source?: string; // "ecc-request-sales-document-data" once wired
  reason?: string; // diagnostics when not priced
};

export function getEccPricingConfig(): EccPricingConfig {
  const env = process.env;
  const enabledRaw = String(env.ECC_PRICING_ENABLED ?? "").trim().toLowerCase();
  const enabledFlag = enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "yes" || enabledRaw === "on";
  const url = String(env.ECC_PRICING_URL ?? "").trim();
  return {
    // Considered "configured" only when explicitly enabled AND an endpoint is set.
    enabled: enabledFlag && url.length > 0,
    url,
    soapAction: String(env.ECC_PRICING_SOAP_ACTION ?? "").trim(),
    certPath: String(env.ECC_PRICING_CLIENT_CERT ?? "").trim(),
    keyPath: String(env.ECC_PRICING_CLIENT_KEY ?? "").trim(),
    pfxPath: String(env.ECC_PRICING_PFX ?? "").trim(),
    passphrase: String(env.ECC_PRICING_CERT_PASSPHRASE ?? ""),
    caPath: String(env.ECC_PRICING_SERVER_CA ?? "").trim(),
    salesOrg: String(env.ECC_PRICING_SALES_ORG ?? "").trim(),
    distributionChannel: String(env.ECC_PRICING_DISTR_CHANNEL ?? "").trim(),
    division: String(env.ECC_PRICING_DIVISION ?? "").trim(),
    currency: String(env.ECC_PRICING_CURRENCY ?? "USD").trim() || "USD",
  };
}

export function isEccPricingConfigured(): boolean {
  return getEccPricingConfig().enabled;
}

// ---------------------------------------------------------------------------
// mTLS transport — REAL. Builds an HTTPS agent carrying the client cert and
// POSTs the SOAP body. Server-cert trust comes from the default CA store
// (which includes the corporate CA when the shim runs with
// NODE_OPTIONS=--use-system-ca); set ECC_PRICING_SERVER_CA to override.
// ---------------------------------------------------------------------------
let cachedAgent: https.Agent | null | undefined; // undefined=not built, null=build failed

function getHttpsAgent(cfg: EccPricingConfig): https.Agent | null {
  if (cachedAgent !== undefined) return cachedAgent;
  try {
    const opts: https.AgentOptions = { keepAlive: true };
    if (cfg.pfxPath) {
      opts.pfx = readFileSync(cfg.pfxPath);
    } else if (cfg.certPath && cfg.keyPath) {
      opts.cert = readFileSync(cfg.certPath);
      opts.key = readFileSync(cfg.keyPath);
    }
    if (cfg.passphrase) opts.passphrase = cfg.passphrase;
    if (cfg.caPath) opts.ca = readFileSync(cfg.caPath);
    cachedAgent = new https.Agent(opts);
  } catch (e: any) {
    console.warn("[ecc_pricing] failed to load client certificate:", e?.message ?? e);
    cachedAgent = null;
  }
  return cachedAgent;
}

/** POST a SOAP body to the CPI endpoint over mutual TLS. Returns {status, body}. */
function postSoap(
  cfg: EccPricingConfig,
  xml: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(cfg.url);
    } catch (e) {
      reject(new Error(`bad ECC_PRICING_URL: ${cfg.url}`));
      return;
    }
    const agent = getHttpsAgent(cfg);
    const payload = Buffer.from(xml, "utf8");
    const req = https.request(
      target,
      {
        method: "POST",
        agent: agent ?? undefined,
        headers: {
          "Content-Type": "text/xml; charset=UTF-8",
          "Content-Length": payload.length,
          SOAPAction: cfg.soapAction || '""',
          Accept: "text/xml, application/soap+xml",
        },
        timeout: 20000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("ECC pricing request timed out")));
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// CONTENT — the two pieces that still need the message contract.
// ---------------------------------------------------------------------------

/**
 * Build the CustomerQuoteRequestExternalSalesDocumentData SOAP request for one
 * material. SCAFFOLD: returns null until a sample request envelope is supplied
 * (then the transport above sends it). The body mirrors a one-line quote:
 * sold-to + sales area + item(material, qty). Reference shell (fill from the
 * real WSDL/sample — namespaces + element names are placeholders):
 *
 *   return `<?xml version="1.0" encoding="UTF-8"?>
 *   <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="<msg-namespace>">
 *     <soap:Body>
 *       <ns:CustomerQuoteRequestExternalSalesDocumentData>
 *         <ns:SalesOrganisationID>${salesOrg}</ns:SalesOrganisationID>
 *         <ns:DistributionChannelCode>${dc}</ns:DistributionChannelCode>
 *         <ns:DivisionCode>${div}</ns:DivisionCode>
 *         <ns:BuyerPartyID>${ctx.customerId ?? ""}</ns:BuyerPartyID>
 *         <ns:Item><ns:ProductID>${productId}</ns:ProductID><ns:Quantity unitCode="EA">${qty}</ns:Quantity></ns:Item>
 *       </ns:CustomerQuoteRequestExternalSalesDocumentData>
 *     </soap:Body>
 *   </soap:Envelope>`;
 */
function buildSoapRequest(_productId: string, _ctx: PricingContext, _cfg: EccPricingConfig): string | null {
  // TODO: return the real envelope once a sample CustomerQuoteRequest-
  // ExternalSalesDocumentData message is provided.
  return null;
}

/**
 * Pull the net price + currency out of the SOAP response. SCAFFOLD: returns
 * null until we know where they sit (a sample response settles the XPath).
 */
function parseSoapPrice(_xml: string): { amount: number; currency: string } | null {
  // TODO: e.g. extract <NetPriceAmount currencyCode="USD">123.45</NetPriceAmount>
  // from the response and return { amount, currency }.
  return null;
}

// 6-hour in-process cache, keyed by material + the pricing dimensions that
// affect the result, so a multi-part Prep-for-PM panel never re-hits ECC for
// the same part within a session.
const priceCache = new Map<string, { price: ProductPrice; at: number }>();
const PRICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function cacheKey(productId: string, ctx: PricingContext, cfg: EccPricingConfig): string {
  return [
    productId,
    ctx.customerId || "",
    ctx.salesOrg || cfg.salesOrg,
    ctx.distributionChannel || cfg.distributionChannel,
    ctx.division || cfg.division,
    ctx.currency || cfg.currency,
    ctx.quantity ?? 1,
  ].join("|");
}

/**
 * Resolve a single product's price from the ECC "Request Sales Document Data"
 * SOAP service. Best-effort by contract — callers render "—" on any
 * non-priced result, so this never throws.
 */
export async function callEccPricing(
  productId: string,
  ctx: PricingContext = {},
): Promise<ProductPrice> {
  const id = String(productId || "").trim();
  if (!id) return { productId: id, priced: false, reason: "no-product-id" };

  const cfg = getEccPricingConfig();
  if (!cfg.enabled) return { productId: id, priced: false, reason: "not-configured" };

  const key = cacheKey(id, ctx, cfg);
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_CACHE_TTL_MS) return hit.price;

  let price: ProductPrice;
  try {
    const xml = buildSoapRequest(id, ctx, cfg);
    if (!xml) {
      // Transport is ready; the request envelope is the remaining drop-in.
      price = {
        productId: id,
        priced: false,
        reason: "soap-request-template-not-wired (provide a sample CustomerQuoteRequestExternalSalesDocumentData envelope)",
      };
    } else {
      const res = await postSoap(cfg, xml);
      if (res.status < 200 || res.status >= 300) {
        price = { productId: id, priced: false, reason: `ecc-http-${res.status}` };
      } else {
        const parsed = parseSoapPrice(res.body);
        price =
          parsed && Number.isFinite(parsed.amount) && parsed.amount > 0
            ? {
                productId: id,
                priced: true,
                amount: parsed.amount,
                currency: parsed.currency || cfg.currency,
                source: "ecc-request-sales-document-data",
              }
            : { productId: id, priced: false, reason: "price-not-found-in-response" };
      }
    }
  } catch (e: any) {
    price = { productId: id, priced: false, reason: `ecc-error: ${String(e?.message ?? e).slice(0, 120)}` };
  }

  priceCache.set(key, { price, at: Date.now() });
  return price;
}

/** Batch wrapper — resolve prices for many products (deduped, capped, cached). */
export async function getProductPrices(
  productIds: string[],
  ctx: PricingContext = {},
): Promise<Record<string, ProductPrice>> {
  const ids = Array.from(
    new Set((productIds || []).map((p) => String(p || "").trim()).filter(Boolean)),
  ).slice(0, 50);
  const out: Record<string, ProductPrice> = {};
  // ECC pricing is per-material; sequential to be gentle on the CPI iflow
  // (results are cached, so repeat panels are instant).
  for (const id of ids) {
    out[id] = await callEccPricing(id, ctx);
  }
  return out;
}
