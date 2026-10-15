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
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
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
    firma: ["🚚", "Firmaga to'lov"], svet: ["⚡", "Svet"], gaz: ["🔥", "Gaz"], soliq: ["🧾", "Soliq"],
    ijara: ["🏠", "Ijara"], oylik: ["👷", "Ish haqi"], boshqa: ["📦", "Boshqa"],
  },
  shaxsiy: {
    oziq: ["🛒", "Oziq-ovqat"], transport: ["🚕", "Transport"], uy: ["🏡", "Uy-ro'zg'or"], kommunal: ["💡", "Kommunal"],
    aloqa: ["📱", "Telefon/internet"], kiyim: ["👕", "Kiyim"], soglik: ["💊", "Sog'liq"], talim: ["📚", "Ta'lim"],
    dam: ["🎉", "Dam olish"], boshqa: ["🧩", "Boshqa"],
  },
};
const SCOPE: Record<string, string> = { dokon: "🏪 Do'kon", shaxsiy: "👤 Shaxsiy" };
const ALL_CATS = [...new Set([...Object.keys(CATS.dokon), ...Object.keys(CATS.shaxsiy)])];
const catLabel = (scope: string, cat: string) => { const c = CATS[scope]?.[cat]; return c ? `${c[0]} ${c[1]}` : `🧩 ${cat}`; };
// Do'kon <-> shaxsiy almashtirganda turini moslash
const SWAP: Record<string, string> = { svet: "kommunal", gaz: "kommunal", soliq: "boshqa", ijara: "uy", oylik: "boshqa", firma: "boshqa", kommunal: "svet", uy: "boshqa" };
const swapCat = (to: string, cat: string) => (CATS[to][cat] ? cat : CATS[to][SWAP[cat]] ? SWAP[cat] : "boshqa");

function cleanItem(x: Row, raw: string | null, source: string) {
  const scope = x.scope === "shaxsiy" ? "shaxsiy" : "dokon";
  const cat = CATS[scope][x.cat] ? x.cat : "boshqa";
  const amount = Math.round(Number(String(x.amount ?? "").replace(/[^\d.]/g, "")) || 0);
  let date = typeof x.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : today();
  if (date > today() || date < dAgo(400)) date = today();
  const firm = scope === "dokon" && cat === "firma" ? String(x.firm ?? "").trim().slice(0, 60) || null : null;
  const note = String(x.note ?? "").trim().slice(0, 120) || null;
  return { scope, cat, amount, firm, note, spent_on: date, source, raw: raw ? raw.slice(0, 1000) : null };
}

/* ---------------- Claude: matndan xarajatlar ---------------- */
const SYSTEM = (d: string) => `Sen o'zbek tilida gapiradigan do'kon egasining xarajat hisobchisisan. Bugun ${d}.
Foydalanuvchi xarajatlarini oddiy gap bilan (ba'zan rus so'zlari aralash, xatolar bilan) yozadi yoki aytadi. Har bir alohida xarajat uchun bitta yozuv chiqar.

scope:
- "dokon" — do'kon/magazin xarajati: firmaga/optomchiga/ta'minotchiga to'lov, tovar uchun pul, do'kon svet/gaz puli, soliq, do'kon ijarasi, sotuvchi/ishchi oyligi.
- "shaxsiy" — oila va o'zi uchun: oziq-ovqat (uyga), taksi/benzin, uy-ro'zg'or, uy kommunal (uy svet/gaz/suv), telefon/internet, kiyim, dori/shifokor, o'qish, dam olish.
Agar "uy", "uyga", "oilaga", "bolalarga" desa — shaxsiy. Firma nomi, "tovar", "do'kon", "magazin", "soliq", "sotuvchi" — dokon.
Faqat "svet", "gaz", "ijara" deb aniq ko'rsatilmagan bo'lsa — dokon deb hisobla.

cat (scope ga mos):
- dokon: firma, svet, gaz, soliq, ijara, oylik, boshqa
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

/* ---------------- Gemini: matndan xarajatlar (tekin) ---------------- */
async function geminiParse(text: string): Promise<{ items: Row[]; reply: string }> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM(today()) }] },
      contents: [{ role: "user", parts: [{ text: text.slice(0, 2000) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            items: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  scope: { type: "STRING", enum: ["dokon", "shaxsiy"] },
                  cat: { type: "STRING", enum: ALL_CATS },
                  amount: { type: "INTEGER" },
                  firm: { type: "STRING" },
                  note: { type: "STRING" },
                  date: { type: "STRING" },
                },
                required: ["scope", "cat", "amount"],
              },
            },
            reply: { type: "STRING" },
          },
          required: ["items"],
        },
      },
    }),
  });
  const j: Row = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gemini: " + (j?.error?.message ?? r.status));
  const out = JSON.parse((j.candidates?.[0]?.content?.parts ?? []).map((p: Row) => p.text ?? "").join("") || "{}");
  return { items: Array.isArray(out.items) ? out.items : [], reply: String(out.reply ?? "") };
}

/* ---------------- Gemini: ovozdan matn ---------------- */
async function transcribe(b64: string, mime: string): Promise<string> {
  await cfg();
  if (!GEMINI_KEY) throw new Error("Ovozli yozish uchun Gemini kaliti hali qo'shilmagan. Hozircha matn bilan yozing ✍️");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: "Audioda o'zbek tilida (ba'zan rus so'zlari aralash) xarajat haqida gapirilgan. Aytilganini aynan o'zbek lotin yozuvida, imlo xatosiz yoz. Raqamlarni raqam bilan yoz (masalan 250 ming). Faqat matnni qaytar, boshqa hech narsa qo'shma. Audio jim bo'lsa bo'sh qaytar." },
        { inline_data: { mime_type: mime, data: b64 } },
      ] }],
      generationConfig: { temperature: 0 },
    }),
  });
  const j: Row = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gemini: " + (j?.error?.message ?? r.status));
  return (j.candidates?.[0]?.content?.parts ?? []).map((p: Row) => p.text ?? "").join("").trim();
}

/* ---------------- Oddiy tahlilchi (Claude kaliti bo'lmasa yoki ishlamasa) ---------------- */
const KW: [RegExp, string, string][] = [
  [/firma|optom|ta'?minot|tovar|zakaz|postavsh|dastavka/i, "dokon", "firma"],
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
  const m = t.toLowerCase().replace(/(\d)[\s.](?=\d{3}\b)/g, "$1").match(/(\d+(?:[.,]\d+)?)\s*(mln|million|milion|m\b|ming|k\b)?/);
  if (!m) return 0;
  const v = parseFloat(m[1].replace(",", "."));
  return Math.round(v * (m[2] ? (/^(mln|million|milion|m)$/.test(m[2]) ? 1e6 : 1e3) : 1));
}
function simpleParse(text: string): { items: Row[]; reply: string } {
  const date = /kecha/i.test(text) ? dAgo(1) : today();
  const items: Row[] = [];
  for (const seg of text.split(/[,;\n]|\bva\b|\bham\b/i)) {
    const amount = parseSum(seg);
    if (!amount) continue;
    const k = KW.find(([re]) => re.test(seg));
    let scope = k ? k[1] : "dokon", cat = k ? k[2] : "boshqa";
    if (/\buy(ga|da|ni|imiz)?\b|oila|bola/i.test(seg)) {
      scope = "shaxsiy";
      cat = cat === "svet" || cat === "gaz" ? "kommunal" : cat === "ijara" ? "uy" : CATS.shaxsiy[cat] ? cat : "boshqa";
    }
    const fm = cat === "firma" ? seg.match(/([A-Za-z\u0400-\u04FF][\w'-]*(?:\s[A-Z][\w'-]*)?)\s+firma/i) : null;
    const note = seg.replace(/\d+(?:[.,\s]\d+)*\s*(mln|million|milion|ming|k|so'?m|sum)?/gi, "").replace(/\s+/g, " ").trim().slice(0, 60);
    items.push({ scope, cat, amount, firm: fm ? fm[1][0].toUpperCase() + fm[1].slice(1) : "", note, date });
  }
  return { items, reply: items.length ? "" : "Summani topmadim. Masalan: «svetga 250 ming to'ladim»" };
}

/* ---------------- saqlash va hisobot ---------------- */
async function saveFromText(text: string, source: string) {
  let parsed: { items: Row[]; reply: string };
  await cfg();
  const ai = CLAUDE_KEY ? claudeParse : GEMINI_KEY ? geminiParse : null;
  if (ai) {
    try { parsed = await ai(text); } catch (e) { console.error(e); parsed = simpleParse(text); }
  } else parsed = simpleParse(text);
  const { items, reply } = parsed;
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

async function reportText(range: string) {
  const from = range === "today" ? today() : range === "week" ? dAgo(6) : monthStart();
  const title = range === "today" ? `📅 <b>Bugun</b> · ${dateUz(today())}` : range === "week" ? "🗓 <b>Oxirgi 7 kun</b>" : `📊 <b>${MONTHS[+today().slice(5, 7) - 1][0].toUpperCase() + MONTHS[+today().slice(5, 7) - 1].slice(1)} oyi</b>`;
  const rs = await rowsFrom(from);
  if (!rs.length) return `${title}\n\nXarajat yo'q.`;
  let t = `${title}\n\n💸 <b>Jami: ${som(total(rs))}</b>\n`;
  for (const sc of ["dokon", "shaxsiy"]) {
    const s = rs.filter((r) => r.scope === sc);
    if (!s.length) continue;
    t += `\n${SCOPE[sc]}: <b>${som(total(s))}</b>\n`;
    const by: Record<string, number> = {};
    s.forEach((r) => (by[r.cat] = (by[r.cat] ?? 0) + Number(r.amount)));
    Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([c, v]) => (t += `   ${catLabel(sc, c)} — ${fmt(v)}\n`));
  }
  if (range === "today") {
    t += `\n<b>Ro'yxat:</b>\n`;
    rs.slice(0, 30).forEach((r) => (t += `• ${line(r)}\n`));
  }
  return t;
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
  inline_keyboard: rows.slice(0, 6).map((r) => [
    { text: `🔁 ${r.scope === "dokon" ? "Shaxsiyga" : "Do'konga"} (${fmt(+r.amount)})`, callback_data: `sw:${r.id}` },
    { text: "🗑", callback_data: `del:${r.id}` },
  ]),
});
const savedText = (rows: Row[]) =>
  `✅ <b>Yozildi:</b>\n` + rows.map((r) => `${SCOPE[r.scope]} · ${line(r)}${r.spent_on !== today() ? ` · ${dateUz(r.spent_on)}` : ""}`).join("\n");

const HELP = `ℹ️ <b>Qanday ishlatiladi</b>

Xarajatni oddiy gap bilan <b>yozing</b> yoki <b>ovozli xabar</b> yuboring:
• <i>Svetga 250 ming to'ladim</i>
• <i>Coca-Cola firmasiga 3 million berdim, soliq 400 ming</i>
• <i>Uyga bozorlik 185 ming, taksi 25 ming</i>
• <i>Kecha sotuvchiga oylik 2 mln berdim</i>

Men tushunib, <b>🏪 Do'kon</b> yoki <b>👤 Shaxsiy</b> xarajatga ajrataman. Xato bo'lsa, 🔁 yoki 🗑 tugmasini bosing.

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
    const id = Number(idS);
    const { data: r } = await db.from("xr_expenses").select("*").eq("id", id).maybeSingle();
    if (!r) { await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Topilmadi" }); return; }
    if (act === "del") {
      await db.from("xr_expenses").delete().eq("id", id);
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: "🗑 O'chirildi" });
      await send(chat, `🗑 O'chirildi: ${line(r)}`);
    } else if (act === "sw") {
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
  const menu: Record<string, () => Promise<unknown>> = {
    "/start": () => send(chat, HELP), "ℹ️ Yordam": () => send(chat, HELP), "/yordam": () => send(chat, HELP),
    "📅 Bugun": async () => send(chat, await reportText("today")), "/bugun": async () => send(chat, await reportText("today")),
    "🗓 7 kun": async () => send(chat, await reportText("week")), "/hafta": async () => send(chat, await reportText("week")),
    "📊 Shu oy": async () => send(chat, await reportText("month")), "/oy": async () => send(chat, await reportText("month")),
    "🌐 Web sahifa": () => webLink(chat), "/web": () => webLink(chat),
    "/chiqish": async () => { await db.from("xr_sessions").delete().neq("token", ""); return send(chat, "🔒 Barcha web havolalar o'chirildi. Yangisi: /web"); },
  };
  const cmd = text.split(/[@\s]/)[0];
  if (menu[cmd]) { await menu[cmd](); return; }
  if (text.startsWith("/")) { await send(chat, HELP); return; }

  const voice = m.voice ?? m.audio;
  if (voice) {
    await tg("sendChatAction", { chat_id: chat, action: "typing" });
    try {
      const f = await tg("getFile", { file_id: voice.file_id });
      const audio = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${f.result.file_path}`).then((r) => r.arrayBuffer());
      const heard = await transcribe(encodeBase64(new Uint8Array(audio)), voice.mime_type || "audio/ogg");
      if (!heard) { await send(chat, "🤔 Ovozni eshitmadim. Qaytadan, aniqroq ayting."); return; }
      const res = await saveFromText(heard, "tg_voice");
      await send(chat, `🎤 <i>«${esc(heard)}»</i>\n\n` + (res.saved.length ? savedText(res.saved) : "🤔 " + esc(res.reply)),
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
      const heard = await transcribe(audio, String(b.mime ?? "audio/wav"));
      if (!heard) return json({ heard: "", saved: [], reply: "Ovozni eshitmadim, qaytadan ayting" });
      const r = await saveFromText(heard, "web_voice");
      return json({ heard, saved: r.saved, reply: r.reply });
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
