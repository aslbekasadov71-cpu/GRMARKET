// Xarajatlar: Telegram bot + web API (faqat egasi uchun)
// Claude matnni tushunib xarajatlarga ajratadi, Gemini ovozni matnga aylantiradi.
// Kerakli secretlar: XR_BOT_TOKEN, ANTHROPIC_API_KEY, GEMINI_API_KEY
// Ixtiyoriy: CLAUDE_MODEL, GEMINI_MODEL, XR_WEB_URL
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
let TG_TOKEN = Deno.env.get("XR_BOT_TOKEN") ?? "";
const CLAUDE_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-haiku-5-5";
let GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-lite-latest";
const WEB_URL = (Deno.env.get("XR_WEB_URL") ?? "https://xarajatlar.onrender.com").replace(/\/$/, "");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------------- sozlamalar ---------------- */
let CFG: Record<string, string> | null = null, CFG_AT = 0;
async function cfg(force = false) {
  if (CFG && !force && Date.now() - CFG_AT < 60_000) return CFG;
  CFG_AT = Date.now();
  const { data } = await db.from("xr_config").select("key,value");
  CFG = Object.fromEntries((data ?? []).map((r: Row) => [r.key, r.value]));
  if (!Deno.env.get("XR_BOT_TOKEN") && CFG!.bot_token) TG_TOKEN = CFG!.bot_token;
  if (!Deno.env.get("GEMINI_API_KEY") && CFG!.gemini_key) GEMINI_KEY = CFG!.gemini_key;
  return CFG!;
}

/* ---------------- sana (Asia/Samarkand) ---------------- */
const OFF = 5 * 3600 * 1000;
const today = () => new Date(Date.now() + OFF).toISOString().slice(0, 10);
const dAgo = (n: number) => new Date(Date.parse(today() + "T00:00:00Z") - n * 864e5).toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + "01";
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const dateUz = (s: string) => { const d = new Date(s + "T00:00:00Z"); return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}`; };

/* ---------------- pul va matn ---------------- */
const fmt = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const som = (n: number) => `${fmt(n)} so'm`;
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------------- turlar ---------------- */
const CATS: Record<string, Record<string, [string, string]>> = {
  dokon: {
    firma: ["🚚", "Firmaga to'lov"], tovar: ["📦", "Tovar xaridi"], svet: ["⚡", "Svet"], gaz: ["🔥", "Gaz"], soliq: ["🧾", "Soliq"],
    ijara: ["🏠", "Ijara"], oylik: ["👷", "Ish haqi"], boshqa: ["🧾", "Boshqa"],
  },
  shaxsiy: {
    oziq: ["🛒", "Oziq-ovqat"], transport: ["🚕", "Transport"], uy: ["🏡", "Uy-ro'zg'or"], kommunal: ["💡", "Kommunal"],
    aloqa: ["📱", "Telefon/internet"], kiyim: ["👕", "Kiyim"], soglik: ["💊", "Sog'liq"], talim: ["📚", "Ta'lim"],
    dam: ["🎉", "Dam olish"], boshqa: ["🧩", "Boshqa"],
  },
};
const SCOPE: Record<string, string> = { dokon: "🏪 Do'kon", shaxsiy: "👤 Shaxsiy" };
const ALL_CATS = [...new Set([...Object.keys(CATS.dokon), ...Object.keys(CATS.shaxsiy), "savdo"])];
const catLabel = (scope: string, cat: string) => { if (cat === "savdo") return "💰 Savdo"; const c = CATS[scope]?.[cat]; return c ? `${c[0]} ${c[1]}` : `🧩 ${cat}`; };
// Do'kon <-> shaxsiy almashtirganda turini moslash
const SWAP: Record<string, string> = { svet: "kommunal", gaz: "kommunal", soliq: "boshqa", ijara: "uy", oylik: "boshqa", firma: "boshqa", tovar: "uy", kommunal: "svet", uy: "boshqa", oziq: "tovar" };
const swapCat = (to: string, cat: string) => (CATS[to][cat] ? cat : CATS[to][SWAP[cat]] ? SWAP[cat] : "boshqa");

function cleanItem(x: Row, raw: string | null, source: string) {
  const kind = x.kind === "savdo" || x.cat === "savdo" ? "savdo" : "xarajat";
  const scope = kind === "savdo" ? "dokon" : x.scope === "shaxsiy" ? "shaxsiy" : "dokon";
  const cat = kind === "savdo" ? "savdo" : CATS[scope][x.cat] ? x.cat : "boshqa";
  const amount = Math.round(Number(String(x.amount ?? "").replace(/[^\d.]/g, "")) || 0);
  let date = typeof x.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : today();
  if (date > today() || date < dAgo(400)) date = today();
  const firm = kind === "xarajat" && scope === "dokon" && cat === "firma" ? String(x.firm ?? "").trim().slice(0, 60) || null : null;
  const note = String(x.note ?? "").trim().slice(0, 120) || null;
  return { kind, scope, cat, amount, firm, note, spent_on: date, source, raw: raw ? raw.slice(0, 1000) : null };
}

/* ---------------- Claude: matndan xarajatlar ---------------- */
const SYSTEM = (d: string) => `Sen o'zbek tilida gapiradigan do'kon egasining xarajat hisobchisisan. Bugun ${d}.
Foydalanuvchi xarajatlarini oddiy gap bilan (ba'zan rus so'zlari aralash, xatolar bilan) yozadi yoki aytadi. Har bir alohida xarajat uchun bitta yozuv chiqar.

kind — avval aniqla:
- "savdo" — do'kon savdosi/tushumi, kassaga kelgan pul: "savdo", "bugungi savdo", "kassa", "tushum", "sotdim", "savdo qildim", "kirim". Bunda scope="dokon", cat="savdo".
- "xarajat" — qolgan hammasi (pul chiqib ketgan).

scope (faqat xarajat uchun) — JUDA MUHIM QOIDA:
- Sukut bo'yicha har doim "dokon".
- Faqat foydalanuvchi o'sha xarajat haqida ANIQ aytsa "shaxsiy" qil: "uyga", "uy uchun", "uyimga", "o'zimga", "o'zim uchun", "shaxsiy", "oilaga", "oilam uchun".
- Bu so'zlar bo'lmasa — o'zingdan taxmin qilma, hatto taksi, ovqat, dadam/opam uchun bo'lsa ham "dokon" yoz.
- Bitta gapda bir nechta xarajat bo'lsa, har biri uchun alohida qaror qil (shaxsiy so'z faqat o'zi tegishli xarajatga ta'sir qiladi).

cat (scope ga mos; savdo bo'lsa "savdo"):
- dokon: firma, tovar, svet, gaz, soliq, ijara, oylik, boshqa
  · firma — firma/optomchi nomi aytilgan to'lov (nomini "firm" ga yoz)
  · tovar — sotish uchun mahsulot/tovar olish, firma nomi aytilmagan (sigaret, qop, paket, ichimlik, non, shirinlik va h.k.)
  · boshqa — do'konga tegishli qolgan hammasi (taksi, ovqat, odamga berilgan pul va h.k.)
- shaxsiy: oziq, transport, uy, kommunal, aloqa, kiyim, soglik, talim, dam, boshqa
Firmaga to'lovda firma nomini "firm" ga yoz (bosh harf bilan, lotin yozuvida).

amount: so'mda butun son. "ellik ming"=50000, "yuz yigirma besh ming"=125000, "bir yarim million"/"1.5 mln"=1500000, "yarim million"=500000, "85 ming"=85000, "3 mln"=3000000, "o'n ming besh yuz"=10500, "250k"=250000.
date: YYYY-MM-DD. "kecha" = bir kun oldin, "o'tgan kuni"/"kechagi kundan oldin" = ikki kun oldin; aytilmasa bugun.
note: qisqa izoh (masalan "non va sut", "Malika uchun dori"), bo'lmasa bo'sh.

Agar matnda xarajat bo'lmasa yoki summa aytilmagan bo'lsa — items bo'sh ro'yxat va "reply" ga qisqa o'zbekcha izoh yoz (nima yetishmayotganini so'ra). Hech narsani to'qib chiqarma.`;

async function claudeParse(text: string): Promise<{ items: Row[]; reply: string }> {
  if (!CLAUDE_KEY) throw new Error("ANTHROPIC_API_KEY sozlanmagan");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM(today()),
      tools: [{
        name: "save_expenses",
        description: "Matndan topilgan xarajatlarni saqlash",
        input_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["xarajat", "savdo"] },
                  scope: { type: "string", enum: ["dokon", "shaxsiy"] },
                  cat: { type: "string", enum: ALL_CATS },
                  amount: { type: "integer", description: "so'mda" },
                  firm: { type: "string" },
                  note: { type: "string" },
                  date: { type: "string", description: "YYYY-MM-DD" },
                },
                required: ["scope", "cat", "amount"],
              },
            },
            reply: { type: "string", description: "Xarajat topilmasa, qisqa izoh" },
          },
          required: ["items"],
        },
      }],
      tool_choice: { type: "tool", name: "save_expenses" },
      messages: [{ role: "user", content: text.slice(0, 2000) }],
    }),
  });
  const j: Row = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude: " + (j?.error?.message ?? r.status));
  const tu = (j.content ?? []).find((c: Row) => c.type === "tool_use");
  return { items: Array.isArray(tu?.input?.items) ? tu.input.items : [], reply: String(tu?.input?.reply ?? "") };
}

/* ---------------- Gemini: band bo'lsa boshqa modelga o'tadi ---------------- */
const G_MODELS = [...new Set([GEMINI_MODEL, "gemini-2.5-flash-lite", "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"])];
async function gemini(body: Row): Promise<string> {
  let last = "";
  for (const model of G_MODELS) {
    for (let k = 0; k < 2; k++) {
      // 2.5-flash sukut bo'yicha "o'ylaydi" (sekin) — xarajat yozish uchun kerak emas
      const b = /^gemini-2\.5-flash$/.test(model) ? { ...body, generationConfig: { ...(body.generationConfig ?? {}), thinkingConfig: { thinkingBudget: 0 } } } : body;
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
      });
      const j: Row = await r.json().catch(() => ({}));
      if (r.ok) return (j.candidates?.[0]?.content?.parts ?? []).map((p: Row) => p.text ?? "").join("");
      last = `${model}: ${j?.error?.message ?? r.status}`;
      console.error("Gemini", last);
      if (r.status === 401 || r.status === 403 || /api.?key/i.test(String(j?.error?.message ?? ""))) throw new Error("Gemini kaliti: " + (j?.error?.message ?? r.status));
      if (r.status === 400 || r.status === 404) break;   // bu model mos emas: keyingisiga                       // bunday model yo'q: keyingisiga
      if (k === 0) await new Promise((ok) => setTimeout(ok, 700)); // band: bir oz kutib, qayta
    }
  }
  throw new Error("Gemini hozir band, birozdan keyin qayta urinib ko'ring");
}

/* ---------------- Gemini: matndan / ovozdan xarajatlar (tekin) ---------------- */
const G_ITEMS = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      kind: { type: "STRING", enum: ["xarajat", "savdo"] },
      scope: { type: "STRING", enum: ["dokon", "shaxsiy"] },
      cat: { type: "STRING", enum: ALL_CATS },
      amount: { type: "INTEGER" },
      firm: { type: "STRING" },
      note: { type: "STRING" },
      date: { type: "STRING" },
    },
    required: ["kind", "scope", "cat", "amount"],
  },
};
// Ovoz: bitta so'rovda ham eshitadi, ham tushunadi (2 marta tezroq)
async function geminiVoice(b64: string, mime: string): Promise<{ heard: string; items: Row[]; reply: string }> {
  const txt = await gemini({
    system_instruction: { parts: [{ text: SYSTEM(today()) + `\n\nSenga audio keladi. "transcript" ga aytilganini aynan o'zbek lotin yozuvida yoz (raqamlarni raqam bilan, masalan 250 ming). Audio jim bo'lsa transcript bo'sh, items bo'sh.` }] },
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: b64 } }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", properties: { transcript: { type: "STRING" }, items: G_ITEMS, reply: { type: "STRING" } }, required: ["transcript", "items"] },
    },
  });
  const out = JSON.parse(txt || "{}");
  return { heard: String(out.transcript ?? "").trim(), items: Array.isArray(out.items) ? out.items : [], reply: String(out.reply ?? "") };
}

async function geminiParse(text: string): Promise<{ items: Row[]; reply: string }> {
  const txt = await gemini({
    system_instruction: { parts: [{ text: SYSTEM(today()) }] },
    contents: [{ role: "user", parts: [{ text: text.slice(0, 2000) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", properties: { items: G_ITEMS, reply: { type: "STRING" } }, required: ["items"] },
    },
  });
  const out = JSON.parse(txt || "{}");
  return { items: Array.isArray(out.items) ? out.items : [], reply: String(out.reply ?? "") };
}

/* ---------------- Gemini: ovozdan matn ---------------- */
async function transcribe(b64: string, mime: string): Promise<string> {
  await cfg();
  if (!GEMINI_KEY) throw new Error("Ovozli yozish uchun Gemini kaliti hali qo'shilmagan. Hozircha matn bilan yozing ✍️");
  return (await gemini({
      contents: [{ parts: [
        { text: "Audioda o'zbek tilida (ba'zan rus so'zlari aralash) xarajat haqida gapirilgan. Aytilganini aynan o'zbek lotin yozuvida, imlo xatosiz yoz. Raqamlarni raqam bilan yoz (masalan 250 ming). Faqat matnni qaytar, boshqa hech narsa qo'shma. Audio jim bo'lsa bo'sh qaytar." },
        { inline_data: { mime_type: mime, data: b64 } },
      ] }],
      generationConfig: { temperature: 0 },
    })).trim();
}

/* ---------------- Oddiy tahlilchi (Claude kaliti bo'lmasa yoki ishlamasa) ---------------- */
const KW: [RegExp, string, string][] = [
  [/firma|optom|ta'?minot|postavsh/i, "dokon", "firma"],
  [/tovar|sigaret|qop|paket|ichimlik|zakaz|mahsulot|shirinlik/i, "dokon", "tovar"],
  [/soliq|nalog/i, "dokon", "soliq"],
  [/oylik|ish ?haqi|zarplat|sotuvchi|ishchi/i, "dokon", "oylik"],
  [/ijara|arenda/i, "dokon", "ijara"],
  [/svet|elektr/i, "dokon", "svet"],
  [/\bgaz/i, "dokon", "gaz"],
  [/taksi|benzin|propan|metan|avtobus|metro|yo'?lkira/i, "shaxsiy", "transport"],
  [/bozor|non\b|go'?sht|sut\b|oziq|ovqat|meva|sabzavot|produkt|guruch|yog'/i, "shaxsiy", "oziq"],
  [/telefon|internet|paynet|wi-?fi|mobil/i, "shaxsiy", "aloqa"],
  [/kiyim|oyoq ?kiyim|ko'?ylak|shim\b|kurtka|tufli/i, "shaxsiy", "kiyim"],
  [/dori|apteka|shifokor|doktor|kasalxona|klinika/i, "shaxsiy", "soglik"],
  [/kurs\b|maktab|bog'?cha|o'?qish|kitob|kontrakt/i, "shaxsiy", "talim"],
  [/kafe|restoran|kino|sayohat|dam olish|to'?y/i, "shaxsiy", "dam"],
  [/uy-?ro'?zg'?or|mebel|idish|remont|ta'?mir/i, "shaxsiy", "uy"],
];
function parseSum(t: string): number {
  const ms = [...t.toLowerCase().replace(/(\d)[\s.](?=\d{3}\b)/g, "$1").matchAll(/(\d+(?:[.,]\d+)?)\s*(mln|million|milion|m\b|ming|k\b)?/g)];
  if (!ms.length) return 0;
  const val = (m: RegExpMatchArray) => parseFloat(m[1].replace(",", ".")) * (m[2] ? (/^(mln|million|milion|m)$/.test(m[2]) ? 1e6 : 1e3) : 1);
  const withUnit = ms.filter((m) => m[2]);
  return Math.round(withUnit.length ? withUnit.reduce((a, m) => a + val(m), 0) : val(ms[0]));   // "3 mln 200 ming" = 3 200 000
}
function simpleParse(text: string): { items: Row[]; reply: string } {
  const date = /kecha/i.test(text) ? dAgo(1) : today();
  const items: Row[] = [];
  for (const seg of text.split(/[,;\n]|\bva\b|\bham\b/i)) {
    const amount = parseSum(seg);
    if (!amount) continue;
    if (/savdo|tushum|kassa|sotdim|sotuv|kirim/i.test(seg)) { items.push({ kind: "savdo", scope: "dokon", cat: "savdo", amount, note: "", date }); continue; }
    const k = KW.find(([re]) => re.test(seg));
    const scope = /\buy(ga|imga|im|imiz)?\b|uy uchun|o'?zimga|o'?zim uchun|shaxsiy|oilaga|oilam/i.test(seg) ? "shaxsiy" : "dokon";
    let cat = k ? k[2] : "boshqa";
    if (!CATS[scope][cat]) cat = swapCat(scope, cat);
    const fm = cat === "firma" ? seg.match(/([A-Za-z\u0400-\u04FF][\w'-]*(?:\s[A-Z][\w'-]*)?)\s+firma/i) : null;
    const note = seg.replace(/\d+(?:[.,\s]\d+)*\s*(mln|million|milion|ming|k|so'?m|sum)?/gi, "").replace(/\s+/g, " ").trim().slice(0, 60);
    items.push({ scope, cat, amount, firm: fm ? fm[1][0].toUpperCase() + fm[1].slice(1) : "", note, date });
  }
  return { items, reply: items.length ? "" : "Summani topmadim. Masalan: «svetga 250 ming to'ladim»" };
}

/* ---------------- ovozni qayta ishlash ---------------- */
async function handleVoice(b64: string, mime: string, source: string): Promise<{ heard: string; saved: Row[]; reply: string }> {
  await cfg();
  if (GEMINI_KEY && !CLAUDE_KEY) {
    const v = await geminiVoice(b64, mime);
    if (!v.heard) return { heard: "", saved: [], reply: "Ovozni eshitmadim, qaytadan aniqroq ayting" };
    const r = await saveItems(v.items.length ? v.items : simpleParse(v.heard).items, v.reply, v.heard, source);
    return { heard: v.heard, ...r };
  }
  const heard = await transcribe(b64, mime);
  if (!heard) return { heard: "", saved: [], reply: "Ovozni eshitmadim, qaytadan aniqroq ayting" };
  return { heard, ...(await saveFromText(heard, source)) };
}

/* ---------------- saqlash va hisobot ---------------- */
async function saveFromText(text: string, source: string) {
  let parsed: { items: Row[]; reply: string };
  await cfg();
  const ai = CLAUDE_KEY ? claudeParse : GEMINI_KEY ? geminiParse : null;
  if (ai) {
    try { parsed = await ai(text); } catch (e) { console.error(e); parsed = simpleParse(text); }
  } else parsed = simpleParse(text);
  return saveItems(parsed.items, parsed.reply, text, source);
}
async function saveItems(items: Row[], reply: string, text: string, source: string) {
  const rows = items.map((x) => cleanItem(x, text, source)).filter((x) => x.amount > 0);
  if (!rows.length) return { saved: [] as Row[], reply: reply || "Xarajatni tushunmadim. Masalan: «svetga 250 ming to'ladim»" };
  const { data, error } = await db.from("xr_expenses").insert(rows).select();
  if (error) throw error;
  return { saved: data ?? [], reply: "" };
}
async function rowsFrom(from: string) {
  const { data } = await db.from("xr_expenses").select("*").gte("spent_on", from)
    .order("spent_on", { ascending: false }).order("created_at", { ascending: false }).limit(5000);
  return data ?? [];
}
const total = (rs: Row[]) => rs.reduce((a, r) => a + Number(r.amount), 0);
const line = (r: Row) => `${catLabel(r.scope, r.cat)}${r.firm ? " · " + esc(r.firm) : ""} — <b>${fmt(+r.amount)}</b>${r.note ? ` <i>(${esc(r.note)})</i>` : ""}`;

const MON3 = ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"];
const dShort = (d: string) => d === today() ? "Bugun" : d === dAgo(1) ? "Kecha" : `${+d.slice(8)}-${MON3[+d.slice(5, 7) - 1]}`;
const hhmm = (ts: string) => new Date(Date.parse(ts) + OFF).toISOString().slice(11, 16);
const bar = (v: number, mx: number) => { const n = Math.max(1, Math.round(v / mx * 8)); return "▰".repeat(n) + "▱".repeat(8 - n); };
const what = (r: Row) => esc(r.firm || r.note || (r.kind === "savdo" ? "Kunlik savdo" : CATS[r.scope]?.[r.cat]?.[1]) || r.cat);
const icon = (r: Row) => r.kind === "savdo" ? "💰" : CATS[r.scope]?.[r.cat]?.[0] ?? "🧩";
const RANGES: Record<string, string> = { today: "📅 Bugun", yday: "◀️ Kecha", week: "🗓 7 kun", month: "📊 Shu oy", prev: "⏪ O'tgan oy" };
function rangeOf(range: string): [string, string, string] {
  const t = today();
  if (range === "yday") return [dAgo(1), dAgo(1), `◀️ <b>Kecha</b> · ${dateUz(dAgo(1))}`];
  if (range === "week") return [dAgo(6), t, `🗓 <b>Oxirgi 7 kun</b> · ${dateUz(dAgo(6))} – ${dateUz(t)}`];
  if (range === "month") { const m = MONTHS[+t.slice(5, 7) - 1]; return [monthStart(), t, `📊 <b>${m[0].toUpperCase() + m.slice(1)} oyi</b> · 1–${+t.slice(8)}`]; }
  if (range === "prev") {
    const d = new Date(Date.parse(monthStart() + "T00:00:00Z") - 864e5).toISOString().slice(0, 10), m = MONTHS[+d.slice(5, 7) - 1];
    return [d.slice(0, 8) + "01", d, `⏪ <b>${m[0].toUpperCase() + m.slice(1)} oyi</b>`];
  }
  return [t, t, `📅 <b>Bugun</b> · ${dateUz(t)}`];
}
const repKb = (cur: string) => ({ inline_keyboard: [
  Object.entries(RANGES).slice(0, 3).map(([k, l]) => ({ text: (k === cur ? "• " : "") + l, callback_data: `rep:${k}` })),
  Object.entries(RANGES).slice(3).map(([k, l]) => ({ text: (k === cur ? "• " : "") + l, callback_data: `rep:${k}` })),
] });

async function reportText(range: string) {
  const [from, to, title] = rangeOf(range);
  const { data } = await db.from("xr_expenses").select("*").gte("spent_on", from).lte("spent_on", to)
    .order("spent_on", { ascending: false }).order("created_at", { ascending: false }).limit(5000);
  const all = data ?? [];
  if (!all.length) return `${title}\n\nBu davrda yozuv yo'q.`;
  const rs = all.filter((r) => r.kind !== "savdo"), sales = all.filter((r) => r.kind === "savdo");
  const tot = total(rs), sv = total(sales), shop = total(rs.filter((r) => r.scope === "dokon")), me = tot - shop;
  const oneDay = from === to;
  let t = `${title}\n\n`;
  if (sv) t += `💰 Savdo: <b>${som(sv)}</b>\n`;
  t += `💸 Xarajat: <b>${som(tot)}</b>${rs.length ? ` · ${rs.length} ta` : ""}\n`;
  if (rs.length && shop && me) t += `     🏪 do'kon ${fmt(shop)} · 👤 shaxsiy ${fmt(me)}\n`;
  if (sv) t += `${sv - tot >= 0 ? "✅" : "🔻"} <b>Qoldi: ${som(sv - tot)}</b>\n`;
  if (!oneDay) {
    const nd = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1);
    t += `📈 Kuniga o'rtacha: ${sv ? `savdo ${fmt(sv / nd)} · ` : ""}xarajat ${fmt(tot / nd)}\n`;
  }
  if (rs.length) {
    const by: Record<string, number> = {};
    rs.forEach((r) => { const k = r.scope + "|" + r.cat; by[k] = (by[k] ?? 0) + Number(r.amount); });
    const cats = Object.entries(by).sort((a, b) => b[1] - a[1]), cm = cats[0][1];
    t += `\n<b>Xarajat nimaga ketdi:</b>\n`;
    cats.forEach(([k, v]) => { const [sc, c] = k.split("|"); t += `${catLabel(sc, c)}\n<code>${bar(v, cm)}</code> ${fmt(v)} · ${Math.round(v / tot * 100)}%\n`; });
  }
  if (oneDay) {
    t += `\n<b>Qachon, nima:</b>\n`;
    [...all].reverse().slice(-40).forEach((r) => (t += `<code>${hhmm(r.created_at)}</code> ${icon(r)} ${what(r)} — <b>${r.kind === "savdo" ? "+" : ""}${fmt(+r.amount)}</b>${r.scope === "shaxsiy" ? " 👤" : ""}\n`));
  } else {
    const dd: Record<string, Row[]> = {};
    all.forEach((r) => (dd[r.spent_on] ||= []).push(r));
    const dayList = Object.entries(dd);
    t += `\n<b>Kunlar bo'yicha:</b>\n`;
    if (range === "week") {
      dayList.forEach(([d, items]) => {
        const s1 = total(items.filter((r) => r.kind === "savdo")), x1 = total(items.filter((r) => r.kind !== "savdo"));
        t += `\n📆 <b>${dShort(d)}</b> — ${s1 ? `💰 ${fmt(s1)} · ` : ""}💸 ${fmt(x1)}${s1 ? ` · qoldi <b>${fmt(s1 - x1)}</b>` : ""}\n`;
        items.filter((r) => r.kind !== "savdo").slice(0, 12).forEach((r) => (t += `   ${icon(r)} ${what(r)} — ${fmt(+r.amount)}\n`));
      });
    } else {
      const dm = Math.max(...dayList.map(([, i]) => total(i.filter((r) => r.kind !== "savdo"))), 1);
      dayList.forEach(([d, items]) => {
        const s1 = total(items.filter((r) => r.kind === "savdo")), x1 = total(items.filter((r) => r.kind !== "savdo"));
        t += `<code>${dShort(d).padEnd(6)} ${bar(x1, dm)}</code> ${fmt(x1)}${s1 ? ` · 💰${fmt(s1)}` : ""}\n`;
      });
      if (rs.length) {
        t += `\n<b>Eng katta 5 ta xarajat:</b>\n`;
        [...rs].sort((a, b) => b.amount - a.amount).slice(0, 5)
          .forEach((r) => (t += `${icon(r)} ${what(r)} — <b>${fmt(+r.amount)}</b> · ${dShort(r.spent_on)}\n`));
      }
    }
  }
  return t.length > 4000 ? t.slice(0, 3990) + "…" : t;
}

/* ---------------- Telegram ---------------- */
async function tg(method: string, body: Row) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok && !String(j.description ?? "").includes("not modified")) console.error(method, j.description);
  return j;
}
const MAIN = {
  keyboard: [[{ text: "📅 Bugun" }, { text: "🗓 7 kun" }, { text: "📊 Shu oy" }], [{ text: "🌐 Web sahifa" }, { text: "ℹ️ Yordam" }]],
  resize_keyboard: true, is_persistent: true,
};
const send = (chat: number, text: string, reply_markup: unknown = MAIN) =>
  tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", reply_markup, link_preview_options: { is_disabled: true } });
const itemKb = (rows: Row[]) => ({
  inline_keyboard: rows.slice(0, 6).map((r) => r.kind === "savdo"
    ? [{ text: `🗑 Savdoni o'chirish (${fmt(+r.amount)})`, callback_data: `del:${r.id}` }]
    : [{ text: `🔁 ${r.scope === "dokon" ? "Shaxsiyga" : "Do'konga"} (${fmt(+r.amount)})`, callback_data: `sw:${r.id}` }, { text: "🗑", callback_data: `del:${r.id}` }]),
});
const savedText = (rows: Row[]) =>
  `✅ <b>Yozildi</b> · ${rows[0]?.spent_on === today() ? "bugun " + hhmm(rows[0].created_at) : dateUz(rows[0]?.spent_on ?? today())}\n\n` +
  rows.map((r) => r.kind === "savdo" ? `💰 <b>Savdo +${fmt(+r.amount)}</b>${r.note ? ` <i>${esc(r.note)}</i>` : ""}` : `${icon(r)} ${what(r)} — <b>${fmt(+r.amount)}</b> <i>${r.scope === "shaxsiy" ? "👤 shaxsiy" : catLabel(r.scope, r.cat).replace(/^\S+ /, "")}</i>`).join("\n") +
  (rows.filter((r) => r.kind !== "savdo").length > 1 ? `\n\n💸 Xarajat jami: <b>${som(total(rows.filter((r) => r.kind !== "savdo")))}</b>` : "");

const HELP = `ℹ️ <b>Qanday ishlatiladi</b>

Xarajatni oddiy gap bilan <b>yozing</b> yoki <b>ovozli xabar</b> yuboring:
• <i>Svetga 250 ming to'ladim</i>
• <i>Coca-Cola firmasiga 3 million berdim, soliq 400 ming</i>
• <i>Uyga bozorlik 185 ming, taksi 25 ming</i>
• <i>Kecha sotuvchiga oylik 2 mln berdim</i>
• <i>Bugungi savdo 3 mln 200 ming</i> — 💰 savdo sifatida yoziladi

Hammasi <b>🏪 Do'kon</b>ga yoziladi. <b>👤 Shaxsiy</b> uchun «uyga», «o'zimga» yoki «shaxsiy» deng.
Xato bo'lsa, 🔁 yoki 🗑 tugmasini bosing.

📅 Bugun · 🗓 7 kun · 📊 Shu oy — hisobotlar
🌐 Web sahifa — grafik va to'liq ro'yxat`;

async function webLink(chat: number) {
  const token = encodeBase64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]!));
  await db.from("xr_sessions").insert({ token });
  return send(chat, "🌐 Web sahifangiz. Havola faqat siz uchun, uni hech kimga bermang 🔒\n\nBarcha qurilmalardan chiqish: /chiqish",
    { inline_keyboard: [[{ text: "🌐 Xarajatlarni ochish", url: `${WEB_URL}/#t=${token}` }]] });
}

async function onTg(upd: Row) {
  const c = await cfg();
  const from: Row | undefined = upd.message?.from ?? upd.callback_query?.from;
  const chatType = upd.message?.chat?.type ?? upd.callback_query?.message?.chat?.type;
  if (!from || chatType !== "private") return;

  // --- egasi qulfi ---
  let owner = c.owner_id;
  if (!owner) {
    const text: string = upd.message?.text ?? "";
    const code = text.startsWith("/start ") ? text.slice(7).trim() : "";
    if (c.claim_code && code === c.claim_code) {
      await db.from("xr_config").upsert({ key: "owner_id", value: String(from.id) });
      await db.from("xr_config").delete().eq("key", "claim_code");
      await cfg(true);
      owner = String(from.id);
      await send(from.id, `Assalomu alaykum, <b>${esc(from.first_name ?? "")}</b>! 👋\n\nBot endi faqat sizga bog'landi 🔒\n\n` + HELP);
      return;
    }
  }
  if (!owner || String(from.id) !== owner) {
    if (upd.message) await tg("sendMessage", { chat_id: from.id, text: "🔒 Bu shaxsiy bot. Kirish yopiq." });
    else await tg("answerCallbackQuery", { callback_query_id: upd.callback_query.id, text: "🔒 Kirish yopiq" });
    return;
  }
  const chat = Number(from.id);

  // --- tugmalar ---
  if (upd.callback_query) {
    const q = upd.callback_query;
    const [act, idS] = String(q.data ?? "").split(":");
    if (act === "rep") {
      await tg("answerCallbackQuery", { callback_query_id: q.id });
      await tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: await reportText(idS), parse_mode: "HTML", reply_markup: repKb(idS) });
      return;
    }
    const id = Number(idS);
    const { data: r } = await db.from("xr_expenses").select("*").eq("id", id).maybeSingle();
    if (!r) { await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Topilmadi" }); return; }
    if (act === "del") {
      await db.from("xr_expenses").delete().eq("id", id);
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: "🗑 O'chirildi" });
      await send(chat, `🗑 O'chirildi: ${line(r)}`);
    } else if (act === "sw" && r.kind !== "savdo") {
      const to = r.scope === "dokon" ? "shaxsiy" : "dokon";
      const cat = swapCat(to, r.cat);
      await db.from("xr_expenses").update({ scope: to, cat, firm: to === "dokon" ? r.firm : null }).eq("id", id);
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: `${SCOPE[to]} ga o'tkazildi` });
      await send(chat, `🔁 ${SCOPE[to]} · ${line({ ...r, scope: to, cat })}`, itemKb([{ ...r, scope: to }]));
    }
    return;
  }

  const m = upd.message;
  const text: string = (m.text ?? m.caption ?? "").trim();
  console.log("tg msg:", m.voice ? "[voice]" : text.slice(0, 80));
  const menu: Record<string, () => Promise<unknown>> = {
    "/start": () => send(chat, HELP), "ℹ️ Yordam": () => send(chat, HELP), "/yordam": () => send(chat, HELP),
    "📅 Bugun": async () => send(chat, await reportText("today"), repKb("today")), "/bugun": async () => send(chat, await reportText("today"), repKb("today")),
    "🗓 7 kun": async () => send(chat, await reportText("week"), repKb("week")), "/hafta": async () => send(chat, await reportText("week"), repKb("week")),
    "📊 Shu oy": async () => send(chat, await reportText("month"), repKb("month")), "/oy": async () => send(chat, await reportText("month"), repKb("month")),
    "🌐 Web sahifa": () => webLink(chat), "/web": () => webLink(chat),
    "/chiqish": async () => { await db.from("xr_sessions").delete().neq("token", ""); return send(chat, "🔒 Barcha web havolalar o'chirildi. Yangisi: /web"); },
  };
  const cmd = menu[text] ? text : text.startsWith("/") ? text.split(/[@\s]/)[0] : "";
  if (cmd && menu[cmd]) { await menu[cmd](); return; }
  if (text.startsWith("/")) { await send(chat, HELP); return; }

  const voice = m.voice ?? m.audio;
  if (voice) {
    await tg("sendChatAction", { chat_id: chat, action: "typing" });
    try {
      const f = await tg("getFile", { file_id: voice.file_id });
      const audio = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${f.result.file_path}`).then((r) => r.arrayBuffer());
      const res = await handleVoice(encodeBase64(new Uint8Array(audio)), voice.mime_type || "audio/ogg", "tg_voice");
      if (!res.heard) { await send(chat, "🤔 Ovozni eshitmadim. Qaytadan, aniqroq ayting."); return; }
      await send(chat, `🎤 <i>«${esc(res.heard)}»</i>\n\n` + (res.saved.length ? savedText(res.saved) : "🤔 " + esc(res.reply)),
        res.saved.length ? itemKb(res.saved) : MAIN);
    } catch (e) {
      console.error(e);
      await send(chat, "⚠️ Xatolik: " + esc((e as Error).message));
    }
    return;
  }
  if (!text) { await send(chat, "Xarajatni yozing yoki ovozli xabar yuboring 🎤"); return; }
  await tg("sendChatAction", { chat_id: chat, action: "typing" });
  try {
    const res = await saveFromText(text, "tg_text");
    await send(chat, res.saved.length ? savedText(res.saved) : "🤔 " + esc(res.reply), res.saved.length ? itemKb(res.saved) : MAIN);
  } catch (e) {
    console.error(e);
    await send(chat, "⚠️ Xatolik: " + esc((e as Error).message));
  }
}

/* ---------------- Web API ---------------- */
async function onApi(req: Request) {
  const b: Row = await req.json().catch(() => ({}));
  const token = String(b.t ?? "");
  if (token.length < 20) return json({ error: "auth" }, 401);
  const { data: s } = await db.from("xr_sessions").select("token").eq("token", token).maybeSingle();
  if (!s) return json({ error: "auth" }, 401);
  db.from("xr_sessions").update({ last_used: new Date().toISOString() }).eq("token", token).then(() => {});

  switch (b.action) {
    case "list": {
      const from = typeof b.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.from) && b.from >= dAgo(400) ? b.from : dAgo(62);
      return json({ rows: await rowsFrom(from), today: today() });
    }
    case "text": {
      const text = String(b.text ?? "").trim();
      if (!text) return json({ error: "Matn bo'sh" }, 400);
      const r = await saveFromText(text, "web_text");
      return json({ saved: r.saved, reply: r.reply });
    }
    case "voice": {
      const audio = String(b.audio ?? "");
      if (!audio || audio.length > 8_000_000) return json({ error: "Audio noto'g'ri" }, 400);
      return json(await handleVoice(audio, String(b.mime ?? "audio/wav"), "web_voice"));
    }
    case "add": {
      const row = cleanItem(b, null, "web_form");
      if (!(row.amount > 0)) return json({ error: "Summani kiriting" }, 400);
      const { data, error } = await db.from("xr_expenses").insert(row).select().single();
      if (error) throw error;
      return json({ saved: [data] });
    }
    case "update": {
      const { data: r } = await db.from("xr_expenses").select("*").eq("id", Number(b.id)).maybeSingle();
      if (!r) return json({ error: "Topilmadi" }, 404);
      const row = cleanItem({ ...r, date: r.spent_on, ...b }, r.raw, r.source);
      delete (row as Row).raw; delete (row as Row).source;
      const { data, error } = await db.from("xr_expenses").update(row).eq("id", r.id).select().single();
      if (error) throw error;
      return json({ row: data });
    }
    case "del": {
      await db.from("xr_expenses").delete().eq("id", Number(b.id));
      return json({ ok: true });
    }
  }
  return json({ error: "action" }, 400);
}

/* ---------------- kirish nuqtasi ---------------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  try {
    if (path.endsWith("/api")) return await onApi(req);

    if (path.endsWith("/setup")) {
      const c = await cfg(true);
      if (!c.setup_secret || url.searchParams.get("k") !== c.setup_secret) return new Response("forbidden", { status: 403 });
      const missing = [["XR_BOT_TOKEN", TG_TOKEN], ["GEMINI_API_KEY", GEMINI_KEY]].filter((x) => !x[1]).map((x) => x[0]);
      if (!TG_TOKEN) return json({ missing });
      const hook = await tg("setWebhook", { url: `${SB_URL}/functions/v1/xarajat/tg`, secret_token: c.webhook_secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
      await tg("setMyCommands", { commands: [
        { command: "bugun", description: "Bugungi xarajatlar" },
        { command: "hafta", description: "Oxirgi 7 kun" },
        { command: "oy", description: "Shu oy" },
        { command: "web", description: "Web sahifa" },
        { command: "yordam", description: "Qo'llanma" },
      ] });
      const me = await tg("getMe", {});
      const user = me?.result?.username;
      return json({ missing, hook: hook.ok, bot: user, owner: !!c.owner_id, claim: !c.owner_id && user ? `https://t.me/${user}?start=${c.claim_code}` : null });
    }

    if (path.endsWith("/tg")) {
      const c = await cfg();
      if (!c.webhook_secret || req.headers.get("x-telegram-bot-api-secret-token") !== c.webhook_secret) return new Response("forbidden", { status: 403 });
      await onTg(await req.json());
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  } catch (e) {
    console.error(e);
    if (path.endsWith("/tg")) return new Response("ok");
    return json({ error: (e as Error).message ?? "Xatolik" }, 500);
  }
});
