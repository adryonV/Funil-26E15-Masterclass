// ============================================================================
// build.mjs — Dashboard "26E15-Masterclass — Meta Ads" (funil de vendas)
// Roda 100% na nuvem (GitHub Actions). Sem dependências.
//
// Cruza 2 planilhas Google (somente leitura, export CSV):
//   1) Métricas dos Anúncios (aba "Meta Ads",       gid 0)
//   2) Lista de Compradores  (aba "26-E15 MASTERCLASS", gid 1675929696)
//
// Regra do imposto: gasto BRUTO fica no data.json; o imposto ×1,1385 é
// aplicado NO DASHBOARD (accAd: t.spend += r.spend * tax), então TODAS as
// métricas (CPM/CPC/CAC/ROAS/…) usam o gasto COM imposto.
//
// A aba é dedicada ao lançamento, então TODAS as vendas dela entram (sem filtro de data).
// ============================================================================
import { writeFile, readFile } from "node:fs/promises";

// ----------------------------------------------------------------- config
const ADS_ID   = "1gpWTiqzKH9IRHWcedTRsTZKf1jUnfyZbvKpTJquziOs";
const ADS_GID  = "0";                 // aba "Meta Ads"
const SALES_ID = "1EFghI3MYmjRvIGKUHTermmTb74DZDNcyrI48bZ_39t4";
const SALES_GID= "1675929696";        // aba "26-E15 MASTERCLASS"
const SALES_TAB= "26-E15 MASTERCLASS";

const TAX_RATE   = 1.1385;            // imposto obrigatório (aplicado no dashboard)
const DATE_FALLBACK = "2026-08-25";   // usado só se não houver linha de anúncio (fallback de date_min/max)
const TRAFFIC_SRC= "meta-ads";        // marcador de venda de tráfego pago
const PAID_STATUS = new Set(["approved","aprovado","aprovada","complete","completed","completa","concluida","concluido","paid","pago",""]); // Hotmart: só venda paga conta (PT + EN)
// Produto CORE: só o pedido que contém este produto conta como venda. Os demais
// produtos do pedido (order bumps) somam receita; pedido sem o core NÃO é venda.
const CORE_PRODUCT = "masterclass best-seller de verdade";   // comparado já normalizado (sem acento/caixa)

const csvUrl = (id, gid) => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;

// ----------------------------------------------------------------- helpers
async function fetchCsv(url, what){
  const r = await fetch(url, { redirect:"follow", headers:{ "User-Agent":"Mozilla/5.0 dash-build" } });
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`);
  const txt = await r.text();
  if (/^\s*<(!doctype|html)/i.test(txt)) throw new Error(`${what}: recebeu HTML (planilha privada? libere "qualquer pessoa com o link → Leitor")`);
  return txt;
}

// Parser CSV RFC-4180 (aspas, vírgulas e quebras de linha dentro de campo).
function parseCsv(text){
  const rows = []; let row = [], field = "", i = 0, q = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (i < s.length){
    const c = s[i];
    if (q){
      if (c === '"'){ if (s[i+1] === '"'){ field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"'){ q = true; i++; continue; }
    if (c === ','){ row.push(field); field = ""; i++; continue; }
    if (c === '\n'){ row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.length && r.some(x => String(x).trim() !== ""));
}

// Cabeçalho → função de acesso por nome (case/acentos tolerante).
function fold(s){ return String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/\s+/g," ").trim(); }
function headerIndex(header){
  const map = new Map();
  header.forEach((h,i) => { const k = fold(h); if (!map.has(k)) map.set(k, i); });
  return (...names) => { for (const n of names){ const i = map.get(fold(n)); if (i !== undefined) return i; } return -1; };
}

// Número pt-BR: "1.234,56" → 1234.56 · "188,94" → 188.94 · "4590" → 4590.
function num(v){
  if (v == null) return 0;
  let s = String(v).trim().replace(/[^\d.,-]/g, "");
  if (!s) return 0;
  const hasC = s.includes(","), hasD = s.includes(".");
  if (hasC && hasD) s = s.replace(/\./g, "").replace(",", ".");   // ponto=milhar, vírgula=decimal
  else if (hasC)    s = s.replace(",", ".");                       // vírgula=decimal
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// Data → "YYYY-MM-DD" (aceita ISO "2026-08-11 08:23" e "11/08/2026 ...").
function isoDate(v){
  const s = String(v||"").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  return "";
}

const normKey = s => fold(s);
// Conta como tráfego pago quem tem utm_source "facebook-ads" OU "meta" (regra do cliente).
const PAID_SRC = new Set(["facebook-ads", "meta"]);
const isPaidSrc = s => PAID_SRC.has(fold(s));

// Nomes do Meta são segmentados por "|" (ex.: "26-E15 | BTS | E4-VEN | ... | Top ads",
// anúncio "BTS | VD_216"). O cliente às vezes INSERE/REMOVE um segmento (ex.: "BTS |")
// DEPOIS que a venda já gravou a UTM antiga → o casamento exato quebra. Estes helpers
// deixam a atribuição tolerante: cauda do anúncio (último segmento = código criativo)
// e casamento de campanha por SUBSEQUÊNCIA de segmentos (tolera token inserido no meio).
const lastSeg = s => { const p = String(s||"").split("|"); return fold(p[p.length-1]); };
const segsOf  = s => String(s||"").split("|").map(x => fold(x)).filter(Boolean);
// short é subsequência de long? (todos os segmentos de short aparecem em long, na ordem)
const isSubseq = (short, long) => { let i = 0; for (const t of long){ if (i < short.length && short[i] === t) i++; } return i === short.length; };

// ----------------------------------------------------------------- ADS
function parseAds(csv){
  const rows = parseCsv(csv);
  const H = rows[0]; const at = headerIndex(H);
  const iDay = at("Day","Dia","Date");
  const iC   = at("Campaign Name","Campanha","Campaign");
  const iS   = at("Ad Set Name","Conjunto","Ad Set");
  const iA   = at("Ad Name","Anúncio","Ad");
  const iSpend = at("Amount Spent","Amount spent (BRL)","Valor usado","Gasto","Spend");
  const iImp = at("Impressions","Impressões");
  const iClk = at("Link Clicks","Clicks","Cliques","Cliques no link");
  const iLpv = at("Landing Page Views","Visualizações da página de destino","Page Views");
  const iIc  = at("Checkouts Initiated","Checkout Initiated","Finalizações de compra iniciadas","Checkouts");
  const ads = [];
  const canonCamp = new Map(), canonSet = new Map(), canonAd = new Map();
  const adAlias   = new Map();   // cauda do anúncio (ex.: "vd_216") -> {name, spend}
  const comboSetAd= new Map();   // "<conjunto>¦<cauda-anúncio>" -> {c,s,a,spend}
  const comboAd   = new Map();   // "<cauda-anúncio>"            -> {c,s,a,spend}
  const campBySet = new Map();   // "<conjunto>"                 -> {c,spend}
  const campList  = new Map();   // "<campanha normalizada>"     -> {segs,name,spend}
  const bump = (map, key, cand) => { const cur = map.get(key); if (!cur || cand.spend > cur.spend) map.set(key, cand); };
  for (const r of rows.slice(1)){
    const d = isoDate(r[iDay]); if (!d) continue;
    const c = (r[iC]||"").trim(), s = (r[iS]||"").trim(), a = (r[iA]||"").trim();
    const spend = num(r[iSpend]);
    ads.push({
      d, c, s, a,
      spend,                      // BRUTO — imposto aplicado no dashboard
      imp: Math.round(num(r[iImp])),
      clk: Math.round(num(r[iClk])),
      lpv: iLpv >= 0 ? Math.round(num(r[iLpv])) : 0,
      ic:  iIc  >= 0 ? Math.round(num(r[iIc]))  : 0,
    });
    if (c) canonCamp.set(normKey(c), c);
    if (s) canonSet.set(normKey(s), s);
    if (a) canonAd.set(normKey(a), a);
    // índices tolerantes a renomeação (cauda do anúncio + combos vindos da planilha)
    const tk = lastSeg(a), setKey = normKey(s);
    if (a && tk){
      bump(adAlias, tk, { name: a, spend });
      bump(comboSetAd, setKey + "¦" + tk, { c, s, a, spend });
      bump(comboAd, tk, { c, s, a, spend });
    }
    if (s && c) bump(campBySet, setKey, { c, spend });
    if (c) bump(campList, normKey(c), { segs: segsOf(c), name: c, spend });
  }
  return { ads, canonCamp, canonSet, canonAd, adAlias, comboSetAd, comboAd, campBySet, campList };
}

// ----------------------------------------------------------------- SALES
function parseSales(csv, canon){
  const rows = parseCsv(csv);
  const H = rows[0]; const at = headerIndex(H);
  // Data da venda = quando foi PAGA (Aprovado em); cai p/ data do pedido / Data/Hora se faltar.
  const iDate = at("Aprovado em","Aprovada em","Data/Hora","Data do pedido","Data da Compra","Data","Date","DATA(UTC-3)");
  const iVal  = at("Valor","Valor da Compra","Bruto","Faturamento","Amount","Value","Revenue");
  const iStat = at("Situação","Situacao","Status");
  const iSrc  = at("UTM Source","Utm_source","utm_source");
  const iMed  = at("UTM Medium","utm_medium");
  const iCamp = at("UTM Campaign","utm_campaign");
  const iCont = at("UTM Content","utm_content");
  const iSck  = at("sck bruto","sck","SCK");
  const iSrcB = at("src bruto");
  const iPed  = at("Pedido","Order","Order Id","Order ID","Transação","Transacao");
  const iProd = at("Produto","Product","Oferta/Produto","Item","Oferta");

  const { canonCamp, canonSet, canonAd, adAlias, comboSetAd, comboAd, campBySet, campList } = canon;
  // Fallback por SCK/src bruto: acha nome conhecido por substring (longest-first).
  const knownAds = [...canonAd.values()].sort((a,b)=>b.length-a.length);
  const knownSets= [...canonSet.values()].sort((a,b)=>b.length-a.length);
  const knownCamp= [...canonCamp.values()].sort((a,b)=>b.length-a.length);
  const findIn = (blob, list) => { const f = fold(blob); for (const name of list){ if (f.includes(fold(name))) return name; } return ""; };
  const campVals = [...campList.values()];
  // Campanha por subsequência de segmentos (tolera "BTS |" inserido no meio).
  // Match onde a UTM é subsequência do nome da planilha (ou vice-versa); desempata por gasto.
  const campBySubseq = uCamp => {
    const su = segsOf(uCamp); if (!su.length) return "";
    let best = null;
    for (const e of campVals){ if (isSubseq(su, e.segs) || isSubseq(e.segs, su)){ if (!best || e.spend > best.spend) best = e; } }
    return best ? best.name : "";
  };

  // Resolve origem + atribuição de UMA linha. Todas as linhas de um pedido
  // (produto principal + order bumps) compartilham a mesma UTM, então qualquer
  // uma serve; ainda assim escolhemos a de melhor atribuição por segurança.
  const resolveRow = r => {
    const paid = isPaidSrc(iSrc >= 0 ? r[iSrc] : "");
    let c = "", s = "", a = "", m = "";
    if (paid){
      const uCamp = iCamp >= 0 ? (r[iCamp]||"").trim() : "";
      const uMed  = iMed  >= 0 ? (r[iMed]||"").trim()  : "";
      const uCont = iCont >= 0 ? (r[iCont]||"").trim() : "";
      // 1) casamento direto por nome
      c = canonCamp.get(normKey(uCamp)) || "";
      s = canonSet.get(normKey(uMed))   || "";
      a = canonAd.get(normKey(uCont))   || "";
      // 2) tolerante a renomeação: anúncio pela cauda (código criativo); campanha por subsequência
      if (!a){ const al = adAlias.get(lastSeg(uCont)); if (al) a = al.name; }
      if (!c) c = campBySubseq(uCamp);
      // 3) deriva o que faltar do combo conjunto+criativo da própria planilha de anúncios
      if (!a || !c || !s){
        const combo = comboSetAd.get(normKey(uMed) + "¦" + lastSeg(uCont)) || comboAd.get(lastSeg(uCont));
        if (combo){ if (!a) a = combo.a; if (!s) s = combo.s; if (!c) c = combo.c; }
      }
      if (!c && s){ const cb = campBySet.get(normKey(uMed)); if (cb) c = cb.c; }
      // 4) último recurso: varre sck/src bruto por nomes conhecidos
      if (!a || !c){
        const blob = [(iSck>=0?r[iSck]:""), (iSrcB>=0?r[iSrcB]:"")].join(" | ");
        if (!a) a = findIn(blob, knownAds);
        if (!s) s = findIn(blob, knownSets);
        if (!c) c = findIn(blob, knownCamp);
      }
      if (a && s && c) m = "ad";
      else if (s && c) m = "adset";
      else if (c)      m = "campaign";
      else             m = "";           // paga mas sem campanha casada → unmatched
    }
    return { src: paid ? TRAFFIC_SRC : "organico", c, s, a, m };
  };
  const rankOf = o => o.src !== TRAFFIC_SRC ? 0
    : o.m === "ad" ? 4 : o.m === "adset" ? 3 : o.m === "campaign" ? 2 : 1;

  // 1 pedido = 1 venda, mas SÓ conta como venda o pedido que contém o produto
  // CORE ("Imersão Lançamento Que Vende"). Os demais produtos do pedido (order
  // bumps) somam receita; pedido sem o core NÃO é venda. Agrupa por Pedido.
  const orders = new Map();
  let skippedStatus = 0, blankSeq = 0;
  for (const r of rows.slice(1)){
    const d = isoDate(r[iDate]); if (!d) continue;
    const status = fold(iStat >= 0 ? r[iStat] : "");
    if (iStat >= 0 && !PAID_STATUS.has(status)){ skippedStatus++; continue; } // só venda paga
    const ped = iPed >= 0 ? fold(r[iPed]) : "";
    const key = ped || ("__semped" + (++blankSeq));   // sem Pedido → conta como venda isolada
    const isCore = iProd < 0 ? true : fold(r[iProd]) === CORE_PRODUCT;   // sem coluna Produto → não filtra
    const line = Object.assign({ d, v: num(r[iVal]) }, resolveRow(r));
    line.rank = rankOf(line);
    const o = orders.get(key);
    if (!o){ orders.set(key, Object.assign(line, { lines:1, hasCore:isCore })); continue; }
    o.v += line.v;                                     // bump → receita do pedido
    o.lines++;
    o.hasCore = o.hasCore || isCore;
    if (line.d < o.d) o.d = line.d;                    // data = a mais antiga do pedido
    if (line.rank > o.rank){                           // melhor atribuição vence
      o.src = line.src; o.c = line.c; o.s = line.s; o.a = line.a; o.m = line.m; o.rank = line.rank;
    }
  }

  const sales = [];
  const counts = { ad:0, adset:0, campaign:0, unmatched:0, none:0 };
  let mergedBumps = 0, excludedNonCore = 0;
  for (const o of orders.values()){
    if (!o.hasCore){ excludedNonCore++; continue; }   // pedido sem o produto core → não é venda
    mergedBumps += o.lines - 1;                        // linhas extras do pedido = order bumps
    if (o.m === "ad") counts.ad++;
    else if (o.m === "adset") counts.adset++;
    else if (o.m === "campaign") counts.campaign++;
    else if (o.src === TRAFFIC_SRC) counts.unmatched++;
    else counts.none++;
    sales.push({ d: o.d, v: o.v, src: o.src, c: o.c, s: o.s, a: o.a, m: o.m });
  }
  return { sales, counts, skippedStatus, mergedBumps, excludedNonCore };
}

// ----------------------------------------------------------------- build
function brNow(){
  const now = new Date();
  const br = new Date(now.getTime() - 3*3600*1000);   // UTC-3
  const p = n => String(n).padStart(2,"0");
  return `${p(br.getUTCDate())}/${p(br.getUTCMonth()+1)}/${br.getUTCFullYear()} ${p(br.getUTCHours())}:${p(br.getUTCMinutes())}`;
}

async function main(){
  const [adsCsv, salesCsv] = await Promise.all([
    fetchCsv(csvUrl(ADS_ID, ADS_GID),   "planilha de anúncios"),
    fetchCsv(csvUrl(SALES_ID, SALES_GID),"planilha de compradores"),
  ]);

  const canon = parseAds(adsCsv);
  const ads = canon.ads;
  const { sales, counts, skippedStatus, mergedBumps, excludedNonCore } = parseSales(salesCsv, canon);

  // Intervalo cobre anúncios E vendas: há dias com venda mas sem gasto lançado
  // ainda (o Meta demora a publicar a linha de hoje). Se olhasse só os anúncios,
  // "Hoje"/"Tudo" travariam no último dia com gasto e esconderiam as vendas de hoje.
  const days = [...ads.map(r => r.d), ...sales.map(s => s.d)].sort();
  const date_min = days[0] || DATE_FALLBACK;
  const date_max = days[days.length-1] || DATE_FALLBACK;

  const trafSales = sales.filter(s => s.src === TRAFFIC_SRC).length;

  const warnings = [];
  if (!ads.length) warnings.push("Nenhuma linha de anúncio encontrada na planilha de métricas.");
  if (skippedStatus) warnings.push(`${skippedStatus} linha(s) de compra com status não-pago foram ignoradas.`);
  if (mergedBumps) warnings.push(`${mergedBumps} order bump(s) somados à venda do mesmo pedido (contam como receita, não como venda nova).`);
  if (excludedNonCore) warnings.push(`${excludedNonCore} pedido(s) sem o produto core "MasterClass Best-Seller de Verdade" não contam como venda (só bumps avulsos).`);
  if (counts.unmatched) warnings.push(`${counts.unmatched} venda(s) de tráfego pago sem UTM/SCK reconhecível — contam no total de mídia, mas ficam "sem campanha".`);

  const meta = {
    title: "26E15-Masterclass — Meta Ads",
    platform: "Meta Ads",
    traffic_source: TRAFFIC_SRC,
    tax: TAX_RATE,
    currency: "BRL",
    generated_at: new Date().toISOString(),
    generated_at_br: brNow(),
    date_min, date_max,
    ads_url:   `https://docs.google.com/spreadsheets/d/${ADS_ID}/edit#gid=${ADS_GID}`,
    sales_url: `https://docs.google.com/spreadsheets/d/${SALES_ID}/edit#gid=${SALES_GID}`,
    sales_tab: SALES_TAB,
    counts: {
      ads_rows: ads.length,
      sales_rows: sales.length,
      traffic_sales: trafSales,
      attribution: counts,
    },
    warnings,
  };

  const data = { meta, ads, sales };
  await writeFile("public/data.json", JSON.stringify(data));

  // Cache-bust: carimba BUILD_ID no index.html a cada build.
  const buildId = new Date().toISOString().replace(/[^\d]/g,"").slice(0,14);
  let html = await readFile("public/index.html", "utf8");
  html = html.replace(/const BUILD_ID = "[^"]*";/, `const BUILD_ID = "${buildId}";`);
  await writeFile("public/index.html", html);

  console.log(`OK · ${ads.length} anúncios · ${sales.length} vendas (${trafSales} tráfego) · atribuição`, counts);
  console.log(`   período ${date_min}..${date_max} · build ${buildId}`);
  if (warnings.length) console.log("   avisos:\n   - " + warnings.join("\n   - "));
}

main().catch(e => { console.error("FALHA no build:", e.message); process.exit(1); });
