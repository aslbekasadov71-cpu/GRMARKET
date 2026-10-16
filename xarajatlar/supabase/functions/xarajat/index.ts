// Xarajatlar: Telegram bot + web API (faqat egasi uchun)
// Claude matnni tushunib xarajatlarga ajratadi, Gemini ovozni matnga aylantiradi.
// Kerakli secretlar: XR_BOT_TOKEN, ANTHROPIC_API_KEY, GEMINI_API_KEY
// Ixtiyoriy: CLAUDE_MODEL, GEMINI_MODEL, XR_WEB_URL
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

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
// 3 ta bo'lim: do'kon, shaxsiy, kommunal va soliq
const CATS: Record<string, Record<string, [string, string]>> = {
  dokon: {
    tovar: ["📦", "Tovar / yuk"], firma: ["🚚", "Firmaga to'lov"], ijara: ["🏠", "Do'kon ijarasi"], oylik: ["👷", "Ish haqi"],
    yol: ["🛻", "Yo'l / yetkazish"], remont: ["🔧", "Do'kon jihozi / remont"], boshqa: ["🏪", "Do'kon boshqa"],
  },
  shaxsiy: {
    oila: ["👪", "Oilaga / qarindoshga"], ovqat: ["🍢", "Ovqat / kafe"], oziq: ["🛒", "Bozor / oziq-ovqat"], transport: ["🚕", "Transport / taksi"],
    uy: ["🏡", "Uy-ro'zg'or"], aloqa: ["📱", "Telefon / internet"], kiyim: ["👕", "Kiyim"], soglik: ["💊", "Sog'liq"],
    talim: ["📚", "Ta'lim"], dam: ["🎱", "Dam olish"], sovga: ["🎁", "Sovg'a"], boshqa: ["🧩", "Shaxsiy boshqa"],
  },
  kommunal: {
    svet: ["⚡", "Svet (elektr)"], gaz: ["🔥", "Gaz"], suv: ["💧", "Suv"], soliq: ["🏛", "Soliq"], kommunal: ["🧾", "Boshqa kommunal"],
  },
};
const SCOPES = ["dokon", "shaxsiy", "kommunal"];
const SCOPE: Record<string, string> = { dokon: "🏪 Do'kon", shaxsiy: "👤 Shaxsiy", kommunal: "🧾 Kommunal va soliq" };
const SCOPE_S: Record<string, string> = { dokon: "🏪 Do'kon", shaxsiy: "👤 Shaxsiy", kommunal: "🧾 Kommunal" };
const ALL_CATS = [...new Set([...SCOPES.flatMap((s) => Object.keys(CATS[s])), "savdo", "qarz"])];
const catLabel = (scope: string, cat: string) => { if (cat === "savdo") return "💰 Savdo"; const c = CATS[scope]?.[cat]; return c ? `${c[0]} ${c[1]}` : `🧩 ${cat}`; };
// Bo'lim almashtirganda turini moslash
const SWAP: Record<string, string> = { ijara: "uy", oylik: "boshqa", firma: "boshqa", tovar: "uy", uy: "boshqa", oziq: "tovar", yol: "transport", transport: "yol", remont: "uy" };
const DEF_CAT: Record<string, string> = { dokon: "boshqa", shaxsiy: "boshqa", kommunal: "kommunal" };
const swapCat = (to: string, cat: string) => (CATS[to][cat] ? cat : CATS[to][SWAP[cat]] ? SWAP[cat] : DEF_CAT[to]);
// Turdan bo'limni topish (AI scope'ni noto'g'ri bersa ham)
const scopeOfCat = (cat: string) => SCOPES.filter((s) => CATS[s][cat]);

function cleanItem(x: Row, raw: string | null, source: string) {
  const kind = x.kind === "savdo" || x.cat === "savdo" ? "savdo" : "xarajat";
  let scope = kind === "savdo" ? "dokon" : SCOPES.includes(x.scope) ? x.scope : "dokon";
  // svet/gaz/suv/soliq har doim kommunal bo'limga
  if (kind === "xarajat" && ["svet", "gaz", "suv", "soliq"].includes(x.cat)) scope = "kommunal";
  else if (kind === "xarajat" && !CATS[scope][x.cat] && scopeOfCat(x.cat).length === 1) scope = scopeOfCat(x.cat)[0];
  const cat = kind === "savdo" ? "savdo" : CATS[scope][x.cat] ? x.cat : DEF_CAT[scope];
  const amount = Math.round(Number(String(x.amount ?? "").replace(/[^\d.]/g, "")) || 0);
  let date = typeof x.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : today();
  if (date > today() || date < dAgo(400)) date = today();
  const firm = kind === "xarajat" && scope === "dokon" && cat === "firma" ? String(x.firm ?? "").trim().slice(0, 60) || null : null;
  const note = String(x.note ?? "").trim().slice(0, 120) || null;
  return { kind, scope, cat, amount, firm, note, spent_on: date, source, raw: raw ? raw.slice(0, 1000) : null };
}

const titleCase = (s: string) => s.trim().replace(/\s+/g, " ").replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());
function cleanDebt(x: Row, raw: string | null, source: string) {
  const amount = Math.round(Number(String(x.amount ?? "").replace(/[^\d.]/g, "")) || 0);
  let date = typeof x.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : today();
  if (date > today() || date < dAgo(400)) date = today();
  return {
    person: titleCase(String(x.person ?? "")).slice(0, 60), dir: x.dir === "out" ? "out" : "in", kind: x.dkind === "pay" || x.kind === "pay" ? "pay" : "debt",
    amount, note: String(x.note ?? "").trim().slice(0, 120) || null, phone: String(x.phone ?? "").trim().slice(0, 30) || null,
    spent_on: date, source, raw: raw ? raw.slice(0, 1000) : null,
  };
}
const pkey = (s: string) => String(s || "").trim().toLowerCase().replace(/[ʻʼ‘’`´]/g, "'").replace(/\s+/g, " ");
async function loadPeople() {
  const { data } = await db.from("xr_debts").select("person").order("created_at", { ascending: false }).limit(500);
  PEOPLE = [...new Set((data ?? []).map((r: Row) => r.person))].slice(0, 60).join(", ");
}
async function debtRows() {
  const { data } = await db.from("xr_debts").select("*").order("created_at", { ascending: false }).limit(5000);
  return data ?? [];
}
function debtPeople(rows: Row[]) {
  const m = new Map<string, Row>();
  for (const r of rows) {
    const k = r.dir + "|" + pkey(r.person);
    let p = m.get(k);
    if (!p) { p = { name: r.person, dir: r.dir, bal: 0, last: r.created_at, lastId: r.id, rows: [] }; m.set(k, p); }
    p.bal += (r.kind === "pay" ? -1 : 1) * Number(r.amount);
    p.rows.push(r);
  }
  return [...m.values()];
}

/* ---------------- Claude: matndan xarajatlar ---------------- */
let PEOPLE = "";
const SYSTEM = (d: string) => `Sen o'zbek tilida gapiradigan do'kon egasining xarajat hisobchisisan. Bugun ${d}.
Foydalanuvchi xarajatlarini oddiy gap bilan (ba'zan rus so'zlari aralash, xatolar bilan) yozadi yoki aytadi. Har bir alohida xarajat uchun bitta yozuv chiqar.

kind — avval aniqla:
- "qarz" — nasiya/qarz haqida gap bo'lsa ("nasiya", "qarz", "qarzga", "qarzini qaytardi", "qarzimni to'ladim", "keyin beraman dedi"). Bunda:
    person — odamning ismi (bosh harf bilan, lotin yozuvida; mavjud ismlardan biriga o'xshasa aynan o'shani yoz),
    dir — "in" = u MENGA qarzdor (mijoz nasiyaga mahsulot oldi, mendan qarz oldi; qarzini qaytarsa ham "in"),
          "out" = MEN unga qarzdorman (men undan/firmadan nasiyaga tovar oldim, undan qarz oldim; men qarzimni to'lasam ham "out"),
    dkind — "debt" = yangi qarz paydo bo'ldi, "pay" = qarz qaytarildi/to'landi,
    scope="dokon", cat="qarz".
  Misollar: "Alisher 85 ming nasiya oldi" → in, debt; "Dilnoza opa 40 mingini qaytardi" → in, pay;
  "Karim akadan 2 mln nasiyaga tovar oldim" → out, debt; "Rustamga qarzimdan 500 ming berdim" → out, pay.
  "Qarz"/"nasiya" so'zi yoki qaytarish ma'nosi bo'lmasa — bu qarz emas (masalan "firmaga 1 mln berdim" — oddiy xarajat).
- "savdo" — do'kon savdosi/tushumi, kassaga kelgan pul: "savdo", "bugungi savdo", "kassa", "tushum", "sotdim", "savdo qildim", "kirim". Bunda scope="dokon", cat="savdo".
- "xarajat" — qolgan hammasi (pul chiqib ketgan).

scope (faqat xarajat uchun) — 3 ta bo'lim, MA'NOSIGA qarab ajrat:
1) "kommunal" — kommunal to'lovlar va soliq: svet / elektr energiya, gaz, suv, chiqindi, issiqlik, kommunal to'lov, soliq / nalog.
   Uyniki yoki do'konniki bo'lishidan qat'i nazar — doim "kommunal".
2) "dokon" — do'kon uchun: sotish uchun tovar/yuk/mahsulot olish (sigaret, qop, paket, ichimlik, non, qaymoq va h.k.),
   firma/optomchiga to'lov, do'kon ijarasi, sotuvchi oyligi, do'konga yuk tashish/yetkazish, do'kon jihozi/remonti.
   "do'konga", "do'kon uchun", "yuk", "tovar", "zakaz" so'zlari bo'lsa — "dokon".
3) "shaxsiy" — o'zim va oilam uchun: oila a'zolari/qarindoshlarga berilgan pul yoki narsa (dadam, oyim, onam, opam, akam, ukam,
   singlim, jiyan, xotinim, bolalarim...), o'zim yegan ovqat (shashlik, osh, kafe, choyxona, fast-fud), shaxsiy xaridlar, kiyim,
   dori, taksi, telefon/internet to'lovi, dam olish (bilyard, kino), sovg'alar, "uyga", "o'zimga", "shaxsiy".
- Noaniq bo'lsa (nima uchunligi aytilmagan) — "dokon".
- Bitta gapda bir nechta xarajat bo'lsa, har biri uchun alohida qaror qil.

cat — bo'limga mos turni tanla, "boshqa"ni faqat hech biri to'g'ri kelmasa ishlat (savdo bo'lsa "savdo"):
- dokon: tovar, firma, ijara, oylik, yol, remont, boshqa
  · firma — firma/optomchi nomi aytilgan to'lov (nomini "firm" ga yoz, bosh harf bilan, lotin yozuvida)
  · tovar — sotish uchun mahsulot/yuk olish, firma nomi aytilmagan
  · yol — do'konning yuki uchun taksi/mashina/yetkazish
- shaxsiy: oila, ovqat, oziq, transport, uy, aloqa, kiyim, soglik, talim, dam, sovga, boshqa
  · oila — oila a'zosi/qarindoshga pul yoki narsa ("dadamga pul berdim", "opam uchun kasha")
  · ovqat — tayyor ovqat yeyish (shashlik, osh, kafe, choyxona); oziq — bozor, uyga oziq-ovqat xaridi
  · sovga — podarka/sovg'a; dam — bilyard, kino, sayohat, to'y
- kommunal: svet, gaz, suv, soliq, kommunal (chiqindi, issiqlik va boshqalar)

amount: so'mda butun son. "ellik ming"=50000, "yuz yigirma besh ming"=125000, "bir yarim million"/"1.5 mln"=1500000, "yarim million"=500000, "85 ming"=85000, "3 mln"=3000000, "o'n ming besh yuz"=10500, "250k"=250000.
date: YYYY-MM-DD. "kecha" = bir kun oldin, "o'tgan kuni"/"kechagi kundan oldin" = ikki kun oldin; aytilmasa bugun.
note: 1-4 so'zli tushunarli nom, foydalanuvchi so'zlari bilan, bosh harf bilan: "Dadamga pul", "Shashlik", "Opam uchun kasha",
  "Jiyanlarga sovg'a", "Sigaret", "Yuk tashish", "Elektr energiya". Har bir xarajatga albatta yoz.

Agar matnda xarajat bo'lmasa yoki summa aytilmagan bo'lsa — items bo'sh ro'yxat va "reply" ga qisqa o'zbekcha izoh yoz (nima yetishmayotganini so'ra). Hech narsani to'qib chiqarma.${PEOPLE ? `\n\nQarz daftaridagi mavjud ismlar: ${PEOPLE}` : ""}`;

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
                  kind: { type: "string", enum: ["xarajat", "savdo", "qarz"] },
                  person: { type: "string" },
                  dir: { type: "string", enum: ["in", "out"] },
                  dkind: { type: "string", enum: ["debt", "pay"] },
                  scope: { type: "string", enum: SCOPES },
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
async function gemini(body: Row, models: string[] = G_MODELS, think = 0): Promise<string> {
  let last = "", best = "";
  for (const model of models) {
    for (let k = 0; k < 2; k++) {
      // 2.5-flash sukut bo'yicha "o'ylaydi" (sekin) — xarajat yozish uchun kerak emas; ustoz uchun biroz o'ylaydi
      const b = /^gemini-2\.5-flash$/.test(model) ? { ...body, generationConfig: { ...(body.generationConfig ?? {}), thinkingConfig: { thinkingBudget: think } } } : body;
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
      });
      const j: Row = await r.json().catch(() => ({}));
      const out = (j.candidates?.[0]?.content?.parts ?? []).filter((p: Row) => !p.thought).map((p: Row) => p.text ?? "").join("");
      const fr = j.candidates?.[0]?.finishReason;
      if (r.ok && (fr !== "MAX_TOKENS" || out.length > 600 || models === G_MODELS)) return out;
      if (r.ok) { if (out.length > best.length) best = out; last = `${model}: chala javob (${fr})`; console.error("Gemini", last); break; }
      last = `${model}: ${j?.error?.message ?? r.status}`;
      console.error("Gemini", last);
      if (r.status === 401 || r.status === 403 || /api.?key/i.test(String(j?.error?.message ?? ""))) throw new Error("Gemini kaliti: " + (j?.error?.message ?? r.status));
      if (r.status === 400 || r.status === 404) break;   // bu model mos emas: keyingisiga                       // bunday model yo'q: keyingisiga
      if (k === 0) await new Promise((ok) => setTimeout(ok, 700)); // band: bir oz kutib, qayta
    }
  }
  if (best) return best;
  throw new Error("Gemini hozir band, birozdan keyin qayta urinib ko'ring");
}

/* ---------------- Gemini: matndan / ovozdan xarajatlar (tekin) ---------------- */
const G_ITEMS = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      kind: { type: "STRING", enum: ["xarajat", "savdo", "qarz"] },
      person: { type: "STRING" },
      dir: { type: "STRING", enum: ["in", "out"] },
      dkind: { type: "STRING", enum: ["debt", "pay"] },
      scope: { type: "STRING", enum: SCOPES },
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
  [/tovar|sigaret|qop|paket|ichimlik|zakaz|mahsulot|shirinlik|\byuk/i, "dokon", "tovar"],
  [/soliq|nalog/i, "kommunal", "soliq"],
  [/svet|elektr/i, "kommunal", "svet"],
  [/\bgaz/i, "kommunal", "gaz"],
  [/\bsuv\b|suvga/i, "kommunal", "suv"],
  [/kommunal|chiqindi|musor|issiqlik/i, "kommunal", "kommunal"],
  [/oylik|ish ?haqi|zarplat|sotuvchi|ishchi/i, "dokon", "oylik"],
  [/ijara|arenda/i, "dokon", "ijara"],
  [/dadam|otam|oyim|onam|opam|akam|ukam|singlim|jiyan|xotinim|bolalar|qarindosh/i, "shaxsiy", "oila"],
  [/podarka|sovg'?a/i, "shaxsiy", "sovga"],
  [/shashlik|\bosh\b|kafe|choyxona|lavash|burger|somsa|tushlik|ovqat/i, "shaxsiy", "ovqat"],
  [/taksi|benzin|propan|metan|avtobus|metro|yo'?lkira/i, "shaxsiy", "transport"],
  [/bozor|non\b|go'?sht|sut\b|oziq|meva|sabzavot|produkt|guruch|yog'/i, "shaxsiy", "oziq"],
  [/telefon|internet|paynet|wi-?fi|mobil/i, "shaxsiy", "aloqa"],
  [/kiyim|oyoq ?kiyim|ko'?ylak|shim\b|kurtka|tufli/i, "shaxsiy", "kiyim"],
  [/dori|apteka|shifokor|doktor|kasalxona|klinika/i, "shaxsiy", "soglik"],
  [/kurs\b|maktab|bog'?cha|o'?qish|kitob|kontrakt/i, "shaxsiy", "talim"],
  [/restoran|kino|sayohat|dam olish|to'?y|bilyard|futbol/i, "shaxsiy", "dam"],
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
    if (/nasiya|qarz/i.test(seg)) {
      const name = (seg.match(/^\s*([A-Za-zʻʼ'\u0400-\u04FF]+(?:\s+(?:aka|opa|ota|ona))?)/) ?? [])[1] ?? "Noma'lum";
      const out = /(dan|imni|imdan)\b.*(oldim|olindi)|men qarz|qarzimni|qarzimdan|to'ladim/i.test(seg);
      items.push({ kind: "qarz", person: name, dir: out ? "out" : "in", dkind: /qaytar|to'la|berdi(?!m)|uzdi/i.test(seg) ? "pay" : "debt", amount, note: "", date });
      continue;
    }
    if (/savdo|tushum|kassa|sotdim|sotuv|kirim/i.test(seg)) { items.push({ kind: "savdo", scope: "dokon", cat: "savdo", amount, note: "", date }); continue; }
    const k = KW.find(([re]) => re.test(seg));
    let scope = k ? k[1] : "dokon";
    if (scope !== "kommunal" && /\buy(ga|imga|im|imiz)?\b|uy uchun|o'?zimga|o'?zim uchun|shaxsiy|oilaga|oilam/i.test(seg)) scope = "shaxsiy";
    let cat = k ? k[2] : DEF_CAT[scope];
    if (!CATS[scope][cat]) cat = swapCat(scope, cat);
    const fm = cat === "firma" ? seg.match(/([A-Za-z\u0400-\u04FF][\w'-]*(?:\s[A-Z][\w'-]*)?)\s+firma/i) : null;
    const note = seg.replace(/\d+(?:[.,\s]\d+)*\s*(mln|million|milion|ming|k|so'?m|sum)?/gi, "").replace(/\s+/g, " ").trim().slice(0, 60);
    items.push({ scope, cat, amount, firm: fm ? fm[1][0].toUpperCase() + fm[1].slice(1) : "", note, date });
  }
  return { items, reply: items.length ? "" : "Summani topmadim. Masalan: «svetga 250 ming to'ladim»" };
}

/* ---------------- ovozni qayta ishlash ---------------- */
async function handleVoice(b64: string, mime: string, source: string, force = false): Promise<{ heard: string; saved: Row[]; debts?: Row[]; reply: string; dup?: Row }> {
  await Promise.all([cfg(), loadPeople()]);
  if (GEMINI_KEY && !CLAUDE_KEY) {
    const v = await geminiVoice(b64, mime);
    if (!v.heard) return { heard: "", saved: [], debts: [], reply: "Ovozni eshitmadim, qaytadan aniqroq ayting" };
    const r = await saveItems(v.items.length ? v.items : simpleParse(v.heard).items, v.reply, v.heard, source, force);
    return { heard: v.heard, ...r };
  }
  const heard = await transcribe(b64, mime);
  if (!heard) return { heard: "", saved: [], debts: [], reply: "Ovozni eshitmadim, qaytadan aniqroq ayting" };
  return { heard, ...(await saveFromText(heard, source, force)) };
}

/* ---------------- saqlash va hisobot ---------------- */
async function saveFromText(text: string, source: string, force = false) {
  let parsed: { items: Row[]; reply: string };
  await Promise.all([cfg(), loadPeople()]);
  const ai = CLAUDE_KEY ? claudeParse : GEMINI_KEY ? geminiParse : null;
  if (ai) {
    try { parsed = await ai(text); } catch (e) { console.error(e); parsed = simpleParse(text); }
  } else parsed = simpleParse(text);
  return saveItems(parsed.items, parsed.reply, text, source, force);
}
async function saveItems(items: Row[], reply: string, text: string, source: string, force = false) {
  const isQ = (x: Row) => x.kind === "qarz" || x.cat === "qarz" || (x.person && x.dir);
  const rows = items.filter((x) => !isQ(x)).map((x) => cleanItem(x, text, source)).filter((x) => x.amount > 0);
  const drows = items.filter(isQ).map((x) => cleanDebt(x, text, source)).filter((x) => x.amount > 0 && x.person);
  if (!rows.length && !drows.length) return { saved: [] as Row[], debts: [] as Row[], reply: reply || "Tushunmadim. Masalan: «svetga 250 ming to'ladim» yoki «Alisher 85 ming nasiya oldi»" };
  // Takror: hammasi oxirgi 15 daqiqada aynan shu summalar bilan yozilgan bo'lsa — saqlamay, so'raymiz
  if (!force && source.startsWith("tg")) {
    const since = new Date(Date.now() - 15 * 60_000).toISOString();
    const [{ data: re }, { data: rd }] = await Promise.all([
      db.from("xr_expenses").select("kind,amount,spent_on,created_at").gte("created_at", since),
      db.from("xr_debts").select("person,dir,kind,amount,created_at").gte("created_at", since),
    ]);
    const okE = rows.every((r) => (re ?? []).some((e: Row) => e.kind === r.kind && +e.amount === r.amount && e.spent_on === r.spent_on));
    const okD = drows.every((d) => (rd ?? []).some((e: Row) => e.dir === d.dir && e.kind === d.kind && +e.amount === d.amount && pkey(e.person) === pkey(d.person)));
    if (okE && okD) {
      const at = [...(re ?? []), ...(rd ?? [])].map((e: Row) => e.created_at as string).sort().pop() ?? "";
      return { saved: [] as Row[], debts: [] as Row[], reply: "", dup: { at, rows, drows } };
    }
  }
  // ismlarni mavjud yozilishiga moslash
  if (drows.length) {
    const { data: ex } = await db.from("xr_debts").select("person,dir").limit(2000);
    drows.forEach((d) => { const m = (ex ?? []).find((e: Row) => e.dir === d.dir && pkey(e.person) === pkey(d.person)); if (m) d.person = m.person; });
  }
  let saved: Row[] = [], debts: Row[] = [];
  if (rows.length) { const { data, error } = await db.from("xr_expenses").insert(rows).select(); if (error) throw error; saved = data ?? []; }
  if (drows.length) { const { data, error } = await db.from("xr_debts").insert(drows).select(); if (error) throw error; debts = data ?? []; }
  return { saved, debts, reply: "" };
}
async function rowsFrom(from: string) {
  const { data } = await db.from("xr_expenses").select("*").gte("spent_on", from)
    .order("spent_on", { ascending: false }).order("created_at", { ascending: false }).limit(5000);
  return data ?? [];
}
const total = (rs: Row[]) => rs.reduce((a, r) => a + Number(r.amount), 0);
const scopeLine = (rs: Row[]) => SCOPES.map((s) => [s, total(rs.filter((r) => r.scope === s))] as [string, number]).filter(([, v]) => v).map(([s, v]) => `${SCOPE_S[s]} ${fmt(v)}`).join(" · ");
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
  if (range === "all") return ["2020-01-01", t, `📚 <b>Barcha yozuvlar</b>`];
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
  const tot = total(rs), sv = total(sales);
  const oneDay = from === to;
  let t = `${title}\n\n`;
  if (sv) t += `💰 Savdo: <b>${som(sv)}</b>\n`;
  t += `💸 Xarajat: <b>${som(tot)}</b>${rs.length ? ` · ${rs.length} ta` : ""}\n`;
  if (scopeLine(rs)) t += `     ${scopeLine(rs)}\n`;
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
    [...all].reverse().slice(-40).forEach((r) => (t += `<code>${hhmm(r.created_at)}</code> ${icon(r)} ${what(r)} — <b>${r.kind === "savdo" ? "+" : ""}${fmt(+r.amount)}</b>${r.scope === "shaxsiy" ? " 👤" : r.scope === "kommunal" ? " 🧾" : ""}\n`));
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

/* ---------------- Grafika (QuickChart: rasm sifatida diagramma) ---------------- */
const C_BLUE = "#2b6cf6", C_GREEN = "#12b76a", C_RED = "#f04438";
const PALETTE = ["#2b6cf6", "#12b76a", "#f79009", "#7a5af8", "#ee46bc", "#06aed4", "#f04438", "#84cc16", "#667085", "#fb6514"];
const plainCat = (sc: string, c: string) => c === "savdo" ? "Savdo" : CATS[sc]?.[c]?.[1] ?? c;
function chartUrl(conf: string, w = 760, h = 460) {
  return `https://quickchart.io/chart?w=${w}&h=${h}&bkg=%23ffffff&devicePixelRatio=2&v=2&c=${encodeURIComponent(conf)}`;
}
const KTICK = `function(v){return v>=1e6?(v/1e6).toFixed(v%1e6?1:0)+' mln':v>=1e3?Math.round(v/1e3)+'k':v}`;
function chartFor(range: string, all: Row[], from: string, to: string, title: string): string | null {
  const rs = all.filter((r) => r.kind !== "savdo");
  if (from === to) {
    if (!rs.length) return null;
    const by: Record<string, number> = {};
    rs.forEach((r) => { const k = plainCat(r.scope, r.cat); by[k] = (by[k] ?? 0) + Number(r.amount); });
    const ent = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const conf = {
      type: "doughnut",
      data: { labels: ent.map(([k, v]) => `${k}  ${fmt(v)}`), datasets: [{ data: ent.map((e) => e[1]), backgroundColor: PALETTE, borderColor: "#fff", borderWidth: 4 }] },
      options: {
        cutoutPercentage: 64, layout: { padding: 18 },
        title: { display: true, text: title, fontSize: 20, fontColor: "#101828", fontStyle: "bold", padding: 14 },
        legend: { position: "right", labels: { fontSize: 15, fontColor: "#344054", boxWidth: 16, padding: 14 } },
        plugins: { datalabels: { display: false }, doughnutlabel: { labels: [{ text: fmt(total(rs)), font: { size: 30, weight: "bold" }, color: "#101828" }, { text: "so'm xarajat", font: { size: 15 }, color: "#8a94a6" }] } },
      },
    };
    return chartUrl(JSON.stringify(conf));
  }
  // kunlar bo'yicha ustunlar: xarajat (qizil) va savdo (yashil)
  const days: string[] = [];
  for (let d = from; d <= to; d = new Date(Date.parse(d + "T00:00:00Z") + 864e5).toISOString().slice(0, 10)) days.push(d);
  const sum = (d: string, s: boolean) => total(all.filter((r) => r.spent_on === d && (r.kind === "savdo") === s));
  const hasS = all.some((r) => r.kind === "savdo");
  const ds: Row[] = [{ label: "Xarajat", data: days.map((d) => sum(d, false)), backgroundColor: C_RED }];
  if (hasS) ds.push({ label: "Savdo", data: days.map((d) => sum(d, true)), backgroundColor: C_GREEN });
  const conf = JSON.stringify({
    type: "bar",
    data: { labels: days.map((d) => `${+d.slice(8)}.${d.slice(5, 7)}`), datasets: ds },
    options: {
      title: { display: true, text: title, fontSize: 20, fontColor: "#101828", fontStyle: "bold", padding: 14 },
      legend: { display: hasS, position: "bottom", labels: { fontSize: 14, boxWidth: 14 } },
      plugins: { datalabels: { display: false } },
      scales: {
        xAxes: [{ gridLines: { display: false }, ticks: { fontColor: "#8a94a6", fontSize: 12 }, barPercentage: 0.75, categoryPercentage: 0.8 }],
        yAxes: [{ gridLines: { color: "#eef1f5", zeroLineColor: "#e6e9ef" }, ticks: { beginAtZero: true, fontColor: "#8a94a6", fontSize: 12, callback: "__K__" } }],
      },
    },
  }).replace('"__K__"', KTICK);
  return chartUrl(conf);
}

/* ---------------- PDF hisobot ---------------- */
const CYR: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "x", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya", ў: "o'", қ: "q", ғ: "g'", ҳ: "h" };
const WIN_EXTRA = "–—“”•…€";
// PDF standart shrifti (WinAnsi) faqat lotin harflarini biladi: emoji va boshqalarni tozalaymiz
function pdfSafe(s: unknown) {
  let t = String(s ?? "").replace(/[ʻʼ‘’`´]/g, "'").replace(/−/g, "-");
  t = t.replace(/[\u0400-\u04FF]/g, (c) => { const l = c.toLowerCase(), r = CYR[l] ?? ""; return c === l ? r : r.charAt(0).toUpperCase() + r.slice(1); });
  return [...t].filter((c) => { const n = c.codePointAt(0)!; return (n >= 32 && n <= 126) || (n >= 160 && n <= 255) || WIN_EXTRA.includes(c); }).join("").replace(/\s+/g, " ").trim();
}
const hexC = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const SN: Record<string, string> = { dokon: "Do'kon", shaxsiy: "Shaxsiy", kommunal: "Kommunal va soliq" };
const nextDay = (d: string) => new Date(Date.parse(d + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);

// Kunlar (yoki oylar) bo'yicha ustunli grafik
function barUrl(all: Row[], from: string, to: string) {
  const days: string[] = [];
  for (let d = from; d <= to && days.length < 800; d = nextDay(d)) days.push(d);
  const monthly = days.length > 62;
  const key = (d: string) => monthly ? d.slice(0, 7) : d;
  const keys = [...new Set(days.map(key))];
  const sum = (k: string, s: boolean) => total(all.filter((r) => key(r.spent_on) === k && (r.kind === "savdo") === s));
  const hasS = all.some((r) => r.kind === "savdo");
  const ds: Row[] = [{ label: "Xarajat", data: keys.map((k) => sum(k, false)), backgroundColor: C_RED }];
  if (hasS) ds.push({ label: "Savdo", data: keys.map((k) => sum(k, true)), backgroundColor: C_GREEN });
  const conf = JSON.stringify({
    type: "bar",
    data: { labels: keys.map((k) => monthly ? `${MON3[+k.slice(5, 7) - 1]} ${k.slice(2, 4)}` : `${+k.slice(8)}.${k.slice(5, 7)}`), datasets: ds },
    options: {
      title: { display: true, text: monthly ? "Oylar bo'yicha" : "Kunlar bo'yicha", fontSize: 18, fontColor: "#101828", fontStyle: "bold" },
      legend: { display: hasS, position: "bottom", labels: { fontSize: 13, boxWidth: 13 } },
      plugins: { datalabels: { display: false } },
      scales: {
        xAxes: [{ gridLines: { display: false }, ticks: { fontColor: "#8a94a6", fontSize: 11 }, barPercentage: 0.75, categoryPercentage: 0.8 }],
        yAxes: [{ gridLines: { color: "#eef1f5" }, ticks: { beginAtZero: true, fontColor: "#8a94a6", fontSize: 11, callback: "__K__" } }],
      },
    },
  }).replace('"__K__"', KTICK);
  return chartUrl(conf, 900, 400);
}

async function buildPdf(range: string): Promise<{ bytes: Uint8Array; name: string; title: string }> {
  const r0 = rangeOf(range);
  let from = r0[0];
  const to = r0[1];
  const title = pdfSafe(plainTitle(r0[2]));
  const [{ data }, drs] = await Promise.all([
    db.from("xr_expenses").select("*").gte("spent_on", from).lte("spent_on", to)
      .order("spent_on", { ascending: true }).order("created_at", { ascending: true }).limit(5000),
    debtRows(),
  ]);
  const all: Row[] = data ?? [];
  if (range === "all" && all.length) from = all[0].spent_on;
  const rs = all.filter((r) => r.kind !== "savdo"), sl = all.filter((r) => r.kind === "savdo");
  const tot = total(rs), sv = total(sl);

  const doc = await PDFDocument.create();
  doc.setTitle(`Xarajatlar hisoboti - ${title}`);
  doc.setAuthor("Xarajatlar bot");
  const F = await doc.embedFont(StandardFonts.Helvetica), FB = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 36, CW = W - 2 * M;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const need = (h: number) => { if (y - h < M + 24) newPage(); };
  const tw = (s: string, size: number, bold = false) => (bold ? FB : F).widthOfTextAtSize(s, size);
  const txt = (s: unknown, x: number, yy: number, size = 10, bold = false, color = "#101828") =>
    page.drawText(pdfSafe(s), { x, y: yy, size, font: bold ? FB : F, color: hexC(color) });
  const txtR = (s: unknown, xr: number, yy: number, size = 10, bold = false, color = "#101828") =>
    txt(s, xr - tw(pdfSafe(s), size, bold), yy, size, bold, color);
  const fit = (s: unknown, w: number, size = 10, bold = false) => {
    let t = pdfSafe(s);
    if (tw(t, size, bold) <= w) return t;
    while (t.length > 1 && tw(t + "…", size, bold) > w) t = t.slice(0, -1);
    return t + "…";
  };
  const box = (x: number, yTop: number, w: number, h: number, color: string, r = 8) =>
    page.drawSvgPath(`M${r},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0 Z`, { x, y: yTop, color: hexC(color) });
  const head = (t: string) => { need(60); y -= 6; txt(t, M, y - 13, 13, true); y -= 26; };
  const tiles = (items: [string, string, string, string][]) => {
    const gap = 10, w = (CW - gap * (items.length - 1)) / items.length, h = 54;
    need(h + 10);
    items.forEach(([l, v, col, bg], i) => {
      const x = M + i * (w + gap);
      box(x, y, w, h, bg, 10);
      txt(fit(l, w - 24, 9), x + 12, y - 19, 9, false, "#667085");
      txt(fit(v, w - 24, 15, true), x + 12, y - 41, 15, true, col);
    });
    y -= h + 12;
  };
  const table = (cols: { t: string; w: number; r?: boolean }[], rows: { c: string[]; col?: (string | undefined)[]; bold?: boolean; bg?: string }[]) => {
    const rh = 18;
    const header = () => {
      need(rh * 2 + 4);
      box(M, y, CW, rh, "#f2f4f7", 4);
      let x = M + 8;
      cols.forEach((c) => { c.r ? txtR(c.t, x + c.w - 16, y - 12.5, 8.5, true, "#667085") : txt(c.t, x, y - 12.5, 8.5, true, "#667085"); x += c.w; });
      y -= rh + 2;
    };
    header();
    for (const row of rows) {
      if (y - rh < M + 24) { newPage(); header(); }
      if (row.bg) box(M, y, CW, rh, row.bg, 3);
      let x = M + 8;
      cols.forEach((c, j) => {
        const v = fit(row.c[j], c.w - 16, 9, row.bold), col = row.col?.[j] ?? "#101828";
        c.r ? txtR(v, x + c.w - 16, y - 12.5, 9, row.bold, col) : txt(v, x, y - 12.5, 9, row.bold, col);
        x += c.w;
      });
      page.drawLine({ start: { x: M, y: y - rh }, end: { x: M + CW, y: y - rh }, thickness: 0.5, color: hexC("#eef1f5") });
      y -= rh;
    }
    y -= 12;
  };
  const image = async (url: string | null, maxH: number) => {
    if (!url) return;
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const png = await doc.embedPng(new Uint8Array(await r.arrayBuffer()));
      let w = CW, h = (w * png.height) / png.width;
      if (h > maxH) { h = maxH; w = (h * png.width) / png.height; }
      need(h + 8);
      page.drawImage(png, { x: M + (CW - w) / 2, y: y - h, width: w, height: h });
      y -= h + 10;
    } catch (e) { console.error("pdf rasm", e); }
  };

  // sarlavha
  box(M, y, CW, 84, "#2b6cf6", 14);
  txt("Xarajatlar hisoboti", M + 18, y - 34, 22, true, "#ffffff");
  txt(title, M + 18, y - 57, 12, false, "#dbe6ff");
  const now = new Date(Date.now() + OFF).toISOString();
  txtR(`Tuzildi: ${dateUz(now.slice(0, 10))} ${now.slice(0, 4)}, ${now.slice(11, 16)}`, M + CW - 18, y - 34, 9, false, "#dbe6ff");
  txtR(`${all.length} ta yozuv`, M + CW - 18, y - 57, 9, false, "#dbe6ff");
  y -= 98;

  if (!all.length) {
    txt("Bu davrda yozuv yo'q.", M, y - 14, 12, false, "#667085");
    y -= 30;
  } else {
    tiles([
      ["Savdo (kirim)", som(sv), "#067647", "#dcfae6"],
      ["Xarajat (chiqim)", som(tot), "#b42318", "#fee4e2"],
      [sv - tot >= 0 ? "Qoldi" : "Kamomad", som(sv - tot), "#1849a9", "#e8f0ff"],
    ]);
    const shopX = total(rs.filter((r) => r.scope === "dokon")), restX = tot - shopX;
    tiles([
      [sv - shopX >= 0 ? "Do'kon foydasi (savdo - do'kon xarajati)" : "Do'kon zarari (savdo - do'kon xarajati)", som(sv - shopX), sv - shopX >= 0 ? "#067647" : "#b42318", sv - shopX >= 0 ? "#dcfae6" : "#fee4e2"],
      ["Shaxsiy + kommunal", som(restX), "#101828", "#f2f4f7"],
    ]);
    tiles(SCOPES.map((s) => {
      const v = total(rs.filter((r) => r.scope === s));
      return [`${SN[s]}${tot ? ` - ${Math.round((v / tot) * 100)}%` : ""}`, som(v), "#101828", "#f2f4f7"] as [string, string, string, string];
    }));

    // grafiklar
    if (from !== to) await image(barUrl(all, from, to), 230);
    if (rs.length) await image(chartFor("today", rs, "x", "x", "Xarajat turlari"), 250);

    // turlar bo'yicha
    if (rs.length) {
      head("Xarajat turlari");
      const by: Record<string, number> = {};
      rs.forEach((r) => { const k = r.scope + "|" + r.cat; by[k] = (by[k] ?? 0) + Number(r.amount); });
      table([{ t: "Tur", w: 200 }, { t: "Bo'lim", w: 130 }, { t: "Ulush", w: 70, r: true }, { t: "Summa", w: CW - 400, r: true }],
        [...Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
          const [s, c] = k.split("|");
          return { c: [CATS[s]?.[c]?.[1] ?? c, SN[s] ?? s, `${Math.round((v / tot) * 100)}%`, fmt(v)] };
        }), { c: ["Jami", "", "100%", fmt(tot)], bold: true, bg: "#f7f8fa" }]);
    }

    // kunlar bo'yicha
    if (from !== to) {
      head("Kunlar bo'yicha");
      const dd: Record<string, Row[]> = {};
      all.forEach((r) => (dd[r.spent_on] ||= []).push(r));
      table([{ t: "Sana", w: 130 }, { t: "Savdo", w: 131, r: true }, { t: "Xarajat", w: 131, r: true }, { t: "Qoldi", w: CW - 392, r: true }],
        [...Object.entries(dd).map(([d, items]) => {
          const s1 = total(items.filter((r) => r.kind === "savdo")), x1 = total(items.filter((r) => r.kind !== "savdo"));
          return { c: [`${dateUz(d)} ${d.slice(0, 4)}`, s1 ? fmt(s1) : "-", x1 ? fmt(x1) : "-", fmt(s1 - x1)], col: [undefined, "#067647", "#b42318", s1 - x1 < 0 ? "#b42318" : "#1849a9"] };
        }), { c: ["Jami", fmt(sv), fmt(tot), fmt(sv - tot)], bold: true, bg: "#f7f8fa" }]);
    }

    // barcha yozuvlar
    head("Barcha yozuvlar");
    table([{ t: "Sana", w: 62 }, { t: "Vaqt", w: 40 }, { t: "Bo'lim", w: 72 }, { t: "Tur", w: 112 }, { t: "Izoh", w: 137 }, { t: "Summa", w: CW - 423, r: true }],
      all.slice(0, 3000).map((r) => {
        const s = r.kind === "savdo";
        return {
          c: [`${+r.spent_on.slice(8)}.${r.spent_on.slice(5, 7)}.${r.spent_on.slice(2, 4)}`, hhmm(r.created_at), s ? "Savdo" : SN[r.scope]?.split(" ")[0] ?? r.scope,
            s ? "Kunlik savdo" : CATS[r.scope]?.[r.cat]?.[1] ?? r.cat, r.firm || r.note || "", `${s ? "+" : "-"}${fmt(+r.amount)}`],
          col: [undefined, "#8a94a6", undefined, undefined, "#344054", s ? "#067647" : "#b42318"],
        };
      }));
  }

  // qarzlar
  const ppl = debtPeople(drs);
  const open = ppl.filter((p) => Math.round(p.bal) > 0).sort((a, b) => (a.dir === b.dir ? b.bal - a.bal : a.dir === "in" ? -1 : 1));
  if (open.length) {
    head("Qarz daftari");
    const bi = open.filter((p) => p.dir === "in").reduce((a, p) => a + p.bal, 0), bo = open.filter((p) => p.dir === "out").reduce((a, p) => a + p.bal, 0);
    tiles([["Menga qarzdor", som(bi), "#067647", "#dcfae6"], ["Mening qarzim", som(bo), "#b42318", "#fee4e2"]]);
    table([{ t: "Ism", w: 190 }, { t: "Holat", w: 150 }, { t: "Oxirgi", w: 80 }, { t: "Qolgan qarz", w: CW - 420, r: true }],
      open.map((p) => ({
        c: [p.name, p.dir === "in" ? "Menga qarzdor" : "Men qarzdorman", dShort(new Date(Date.parse(p.last) + OFF).toISOString().slice(0, 10)), fmt(p.bal)],
        col: [undefined, p.dir === "in" ? "#067647" : "#b42318", "#8a94a6", p.dir === "in" ? "#067647" : "#b42318"],
      })));
  }

  // sahifa raqami
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const t = pdfSafe(`Xarajatlar hisoboti · ${title} · ${i + 1}/${pages.length}`);
    p.drawText(t, { x: M, y: 18, size: 8, font: F, color: hexC("#8a94a6") });
  });
  const bytes = await doc.save();
  return { bytes, name: `hisobot_${from}_${to}.pdf`, title };
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
const APP_V = "14"; // ilova yangilanganda Telegram eski nusxani ko'rsatmasligi uchun
const appUrl = () => CFG?.app_token ? `${WEB_URL}/?v=${APP_V}#t=${CFG.app_token}` : `${WEB_URL}/?v=${APP_V}`;
const B = {
  today: "📅 Bugun", report: "📊 Hisobot", debts: "📒 Qarzlar", app: "📱 Ilovani ochish", help: "💡 Yordam", pdf: "📄 PDF hisobot", holat: "📈 Do'kon holati", ustoz: "🧑‍🏫 Ustoz", rev: "📦 Revizya",
};
const mainKb = () => ({
  keyboard: [
    [{ text: B.today }, { text: B.report }, { text: B.holat }],
    [{ text: B.ustoz }, { text: B.rev }],
    [{ text: B.debts }, { text: B.pdf }],
    [{ text: B.app, web_app: { url: appUrl() } }, { text: B.help }],
  ],
  resize_keyboard: true, is_persistent: true, input_field_placeholder: "Xarajat, savdo yoki qarzni yozing / ayting 🎤",
});
async function ensureAppToken() {
  const c = await cfg();
  if (c.app_token) return c.app_token;
  const token = encodeBase64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, (x) => ({ "+": "-", "/": "_", "=": "" }[x]!));
  await db.from("xr_sessions").insert({ token });
  await db.from("xr_config").upsert({ key: "app_token", value: token });
  await cfg(true);
  return token;
}
const send = (chat: number, text: string, reply_markup: unknown = mainKb()) =>
  tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", reply_markup, link_preview_options: { is_disabled: true } });
const itemKb = (rows: Row[], debts: Row[] = []) => ({
  inline_keyboard: [
    ...rows.slice(0, 6).map((r) => r.kind === "savdo"
      ? [{ text: `🗑 Savdoni o'chirish · ${fmt(+r.amount)}`, callback_data: `del:${r.id}` }]
      : [...SCOPES.filter((s) => s !== r.scope).map((s) => ({ text: `→ ${SCOPE_S[s]}`, callback_data: `mv:${r.id}:${s}` })), { text: `🗑 ${short(+r.amount)}`, callback_data: `del:${r.id}` }]),
    ...debts.slice(0, 4).map((d) => [{ text: `🗑 ${esc(d.person)} · ${fmt(+d.amount)}`, callback_data: `dl:${d.id}` }, { text: "📒 Qarzlar", callback_data: `dt:${d.dir}` }]),
  ],
});
const catKb = (id: number, scope: string, cur: string) => ({
  inline_keyboard: chunk(Object.entries(CATS[scope]).map(([k, [e, l]]) => ({ text: `${k === cur ? "✓ " : ""}${e} ${l}`, callback_data: `ct:${id}:${k}` })), 2),
});
const KL: Record<string, Record<string, string>> = { in: { debt: "nasiyaga oldi", pay: "qarzini qaytardi" }, out: { debt: "men qarz oldim", pay: "men to'ladim" } };
async function savedText(rows: Row[], debts: Row[] = []) {
  const first = rows[0] ?? debts[0];
  let t = `✅ <b>Yozildi</b> · ${first?.spent_on === today() ? "bugun " + hhmm(first.created_at) : dateUz(first?.spent_on ?? today())}\n`;
  if (rows.length) {
    t += "\n" + rows.map((r) => r.kind === "savdo"
      ? `💰 <b>Savdo  +${fmt(+r.amount)}</b>${r.note ? `  <i>${esc(r.note)}</i>` : ""}`
      : `${icon(r)} ${what(r)} — <b>${fmt(+r.amount)}</b>\n     <i>${SCOPE_S[r.scope] ?? ""} · ${catLabel(r.scope, r.cat).replace(/^\S+ /, "")}</i>`).join("\n");
    const ex = rows.filter((r) => r.kind !== "savdo");
    if (ex.length > 1) t += `\n<b>💸 Jami: ${som(total(ex))}</b>`;
  }
  if (debts.length) {
    const ppl = debtPeople(await debtRows());
    t += `\n\n📒 <b>Qarz daftari</b>\n` + debts.map((d) => {
      const p = ppl.find((x) => x.dir === d.dir && pkey(x.name) === pkey(d.person));
      const b = Math.round(p?.bal ?? 0);
      return `${d.dir === "in" ? "🟢" : "🔴"} <b>${esc(d.person)}</b> ${KL[d.dir][d.kind]} — ${d.kind === "pay" ? "−" : "+"}${fmt(+d.amount)}\n     ${b < 0 ? `⚠️ qarzdan <b>${fmt(-b)}</b> ko'p to'landi — tekshiring` : b === 0 ? "✅ qarz yopildi" : `qolgan qarz: <b>${som(b)}</b>`}`;
    }).join("\n");
  }
  return t;
}

/* --- hisobot: rasm + qisqa xulosa, batafsil ro'yxat alohida tugmada --- */
async function rangeRows(range: string) {
  const [from, to, title] = rangeOf(range);
  const { data } = await db.from("xr_expenses").select("*").gte("spent_on", from).lte("spent_on", to)
    .order("spent_on", { ascending: false }).order("created_at", { ascending: false }).limit(5000);
  return { from, to, title, all: data ?? [] };
}
const plainTitle = (t: string) => t.replace(/<[^>]+>/g, "").replace(/^\S+\s/, "");
function summaryCaption(title: string, all: Row[]) {
  if (!all.length) return `${title}\n\n📭 Bu davrda yozuv yo'q.\n\n<i>Xarajat yoki savdoni yozing yoki ovozli xabar yuboring 🎤</i>`;
  const rs = all.filter((r) => r.kind !== "savdo"), sv = total(all.filter((r) => r.kind === "savdo")), tot = total(rs);
  let t = `${title}\n\n`;
  if (sv) t += `💰 Savdo        <b>${som(sv)}</b>\n`;
  t += `💸 Xarajat      <b>${som(tot)}</b>\n`;
  if (sv) t += `${sv >= tot ? "✅" : "🔻"} Qoldi          <b>${som(sv - tot)}</b>\n`;
  if (rs.length) t += `\n<b>Bo'limlar:</b>\n` + SCOPES.map((s) => { const v = total(rs.filter((r) => r.scope === s)); return `${SCOPE[s]} — <b>${fmt(v)}</b>${v && tot ? ` · ${Math.round(v / tot * 100)}%` : ""}`; }).join("\n") + "\n";
  if (rs.length) {
    const by: Record<string, number> = {};
    rs.forEach((r) => { const k = r.scope + "|" + r.cat; by[k] = (by[k] ?? 0) + Number(r.amount); });
    const ent = Object.entries(by).sort((a, b) => b[1] - a[1]);
    t += `\n<b>Eng ko'p ketgan:</b>\n` + ent.slice(0, 5).map(([k, v]) => { const [sc, c] = k.split("|"); return `${catLabel(sc, c)} — ${fmt(v)} · ${Math.round(v / tot * 100)}%`; }).join("\n");
    if (ent.length > 5) t += `\n<i>… yana ${ent.length - 5} tur</i>`;
  }
  return t;
}
// rasm izohi 1024 belgidan oshmasin (teg o'rtasidan kesmaslik uchun qator bo'yicha)
function fitCaption(t: string) {
  if (t.length <= 1024) return t;
  const lines = t.split("\n");
  while (lines.length > 1 && lines.join("\n").length > 1010) lines.pop();
  return lines.join("\n") + "\n…";
}
const repKb2 = (cur: string) => ({ inline_keyboard: [
  Object.entries(RANGES).slice(0, 3).map(([k, l]) => ({ text: (k === cur ? "✓ " : "") + l, callback_data: `rep:${k}` })),
  Object.entries(RANGES).slice(3).map(([k, l]) => ({ text: (k === cur ? "✓ " : "") + l, callback_data: `rep:${k}` })),
  [{ text: "📋 Batafsil ro'yxat", callback_data: `rd:${cur}` }, { text: "📄 PDF yuklab olish", callback_data: `pdf:${cur}` }],
  [{ text: "📈 Do'kon holati", callback_data: `hl:${cur === "prev" ? "prev" : cur === "week" ? "week" : "month"}` }, { text: "📱 Ilovada ko'rish", web_app: { url: appUrl() } }],
] });

/* --- PDF ni Telegramga fayl qilib yuborish --- */
const PDF_R: [string, string][] = [["today", "Bugun"], ["week", "7 kun"], ["month", "Shu oy"], ["prev", "O'tgan oy"], ["all", "Hammasi"]];
const pdfKb = (cur = "") => ({ inline_keyboard: [
  PDF_R.slice(0, 3).map(([k, l]) => ({ text: `${k === cur ? "✓ " : "📄 "}${l}`, callback_data: `pdf:${k}` })),
  PDF_R.slice(3).map(([k, l]) => ({ text: `${k === cur ? "✓ " : "📄 "}${l}`, callback_data: `pdf:${k}` })),
] });
async function sendPdf(chat: number, range: string) {
  await tg("sendChatAction", { chat_id: chat, action: "upload_document" });
  const { bytes, name, title } = await buildPdf(range);
  const fd = new FormData();
  fd.append("chat_id", String(chat));
  fd.append("caption", `📄 <b>Hisobot</b> · ${esc(title)}\n<i>Boshqa davr uchun pastdagi tugmalarni bosing</i>`);
  fd.append("parse_mode", "HTML");
  fd.append("reply_markup", JSON.stringify(pdfKb(range)));
  fd.append("document", new Blob([bytes], { type: "application/pdf" }), name);
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: "POST", body: fd });
  const j: Row = await r.json().catch(() => ({}));
  if (!j.ok) { console.error("sendDocument", j.description); throw new Error("PDF yuborilmadi: " + (j.description ?? r.status)); }
}
async function sendReport(chat: number, range: string, msg?: Row, pre = "", post = "") {
  const { from, to, title, all } = await rangeRows(range);
  const caption = fitCaption(pre + summaryCaption(title, all) + post);
  const photo = all.length ? chartFor(range, all, from, to, plainTitle(title)) : null;
  const kb = repKb2(range);
  if (msg) {
    if (photo && msg.photo) {
      const r = await tg("editMessageMedia", { chat_id: chat, message_id: msg.message_id, media: { type: "photo", media: photo, caption, parse_mode: "HTML" }, reply_markup: kb });
      if (r.ok || String(r.description ?? "").includes("not modified")) return;
    } else if (!photo && !msg.photo) {
      await tg("editMessageText", { chat_id: chat, message_id: msg.message_id, text: caption, parse_mode: "HTML", reply_markup: kb });
      return;
    }
    await tg("deleteMessage", { chat_id: chat, message_id: msg.message_id });
  }
  if (photo) {
    const r = await tg("sendPhoto", { chat_id: chat, photo, caption, parse_mode: "HTML", reply_markup: kb });
    if (r.ok) return;
  }
  await send(chat, caption, kb);
}

/* --- qarz daftari --- */
const ago = (ts: string) => { const d = Math.round((Date.now() - Date.parse(ts)) / 864e5); return d <= 0 ? "bugun" : d === 1 ? "kecha" : `${d} kun oldin`; };
async function debtsView(tab: string) {
  const ppl = debtPeople(await debtRows());
  const open = (p: Row) => Math.round(p.bal) > 0;
  const inn = ppl.filter((p) => p.dir === "in" && open(p)), out = ppl.filter((p) => p.dir === "out" && open(p)), done = ppl.filter((p) => !open(p));
  const list = (tab === "out" ? out : tab === "done" ? done : inn).sort((a, b) => tab === "done" ? (b.last > a.last ? 1 : -1) : b.bal - a.bal);
  let t = `📒 <b>Qarz daftari</b>\n\n🟢 Menga qarzdor   <b>${som(total(inn.map((p) => ({ amount: p.bal }))))}</b> · ${inn.length} kishi\n🔴 Mening qarzim    <b>${som(total(out.map((p) => ({ amount: p.bal }))))}</b> · ${out.length} kishi\n`;
  t += `\n<b>${tab === "out" ? "🔴 Men qarzdor bo'lganlar" : tab === "done" ? "✅ Yopilgan qarzlar" : "🟢 Menga qarzdorlar"}:</b>\n`;
  t += list.length ? list.slice(0, 25).map((p, i) => `${i + 1}. ${esc(p.name)} — <b>${tab === "done" ? "yopilgan" : fmt(p.bal)}</b> <i>· ${ago(p.last)}</i>`).join("\n")
    : `<i>Bo'sh. Yozish uchun ayting: «Alisher 85 ming nasiya oldi»</i>`;
  const kb = { inline_keyboard: [
    [{ text: `${tab === "in" ? "✓ " : ""}🟢 Menga (${inn.length})`, callback_data: "dt:in" }, { text: `${tab === "out" ? "✓ " : ""}🔴 Men (${out.length})`, callback_data: "dt:out" }, { text: `${tab === "done" ? "✓ " : ""}✅ Yopilgan`, callback_data: "dt:done" }],
    ...chunk(list.slice(0, 12).map((p) => ({ text: `👤 ${p.name} · ${tab === "done" ? "✓" : short(p.bal)}`, callback_data: `dp:${p.lastId}` })), 2),
  ] };
  return { t, kb };
}
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const short = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + " mln" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
async function personView(lastId: number) {
  const { data: r0 } = await db.from("xr_debts").select("*").eq("id", lastId).maybeSingle();
  if (!r0) return null;
  const ppl = debtPeople(await debtRows());
  const p = ppl.find((x) => x.dir === r0.dir && pkey(x.name) === pkey(r0.person));
  if (!p) return null;
  const b = Math.round(p.bal);
  let t = `👤 <b>${esc(p.name)}</b>\n${p.dir === "in" ? "🟢 Menga qarzdor" : "🔴 Men unga qarzdorman"}\n\n${b < 0 ? `⚠️ <b>Qarzdan ${som(-b)} ko'p to'langan</b> — yozuvlarni tekshiring` : b === 0 ? "✅ <b>Qarz yopilgan</b>" : `Qolgan qarz: <b>${som(b)}</b>`}\n\n<b>Tarix:</b>\n`;
  t += p.rows.slice(0, 25).map((r: Row) => `${dShort(r.spent_on)} · ${r.kind === "pay" ? "💵" : "➕"} ${KL[r.dir][r.kind]} <b>${r.kind === "pay" ? "−" : "+"}${fmt(+r.amount)}</b>${r.note ? ` <i>(${esc(r.note)})</i>` : ""}`).join("\n");
  t += `\n\n<i>Qo'shish uchun ayting: «${esc(p.name)} 50 ming ${p.dir === "in" ? "qaytardi" : "ga qarzimdan berdim"}»</i>`;
  const kb = { inline_keyboard: [[{ text: "🗑 Oxirgi yozuvni o'chirish", callback_data: `dl:${p.rows[0].id}` }], [{ text: "⬅️ Qarzlarga qaytish", callback_data: `dt:${p.dir}` }]] };
  return { t, kb };
}

/* --- takroriy yozuvdan himoya --- */
// Telegram bir xil xabarni qayta yuborsa (update_id) — jim o'tkazib yuboramiz
async function firstTime(key: string) {
  const { data, error } = await db.from("xr_seen").upsert({ key }, { onConflict: "key", ignoreDuplicates: true }).select("key");
  return !!error || (data ?? []).length > 0;
}
// Bir xil ovoz yoki matn yaqinda yozilganmi? Yozilgan bo'lsa — o'sha vaqtni qaytaradi
async function recentDup(key: string, mins: number, val: Row) {
  const { data } = await db.from("xr_seen").select("created_at,val").eq("key", key).maybeSingle();
  const was = data?.val?.ok && Date.now() - Date.parse(data.created_at) < mins * 60_000 ? data.created_at as string : null;
  // keyinchalik «Ha, yana yozilsin» uchun kerak; ok=false — hali muvaffaqiyatli saqlanmagan
  if (!was) await db.from("xr_seen").upsert({ key, val: { ...val, ok: false }, created_at: new Date().toISOString() });
  return was;
}
const markSaved = (key: string, val: Row) => db.from("xr_seen").upsert({ key, val: { ...val, ok: true }, created_at: new Date().toISOString() });
const normText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
async function sha(s: string) {
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
const dupKb = (key: string) => ({ inline_keyboard: [[{ text: "✅ Ha, yana yozilsin", callback_data: `ag:${key}` }, { text: "❌ Kerak emas", callback_data: "no:" }]] });

async function doVoice(chat: number, fileId: string, mime: string, force = false, uniq = "") {
  if (!force && uniq) {
    const was = await recentDup("v:" + uniq, 7 * 24 * 60, { f: fileId, m: mime });
    if (was) { await send(chat, `⚠️ <b>Bu ovozli xabar ${dShort(new Date(Date.parse(was) + OFF).toISOString().slice(0, 10)).toLowerCase()} ${hhmm(was)} da yozilgan.</b>\nIkki marta yozilmasligi uchun to'xtatdim. Yana yozaymi?`, dupKb("v:" + uniq)); return; }
  }
  await tg("sendChatAction", { chat_id: chat, action: "typing" });
  try {
    const f = await tg("getFile", { file_id: fileId });
    const audio = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${f.result.file_path}`).then((r) => r.arrayBuffer());
    const res = await handleVoice(encodeBase64(new Uint8Array(audio)), mime || "audio/ogg", "tg_voice", force);
    if (!res.heard) { await send(chat, "🤔 Ovozni eshitmadim. Qaytadan, aniqroq ayting."); return; }
    if (res.dup) {
      const key = "v:" + (uniq || await sha(fileId));
      await db.from("xr_seen").upsert({ key, val: { f: fileId, m: mime } });
      await send(chat, `🎤 <i>«${esc(res.heard)}»</i>\n\n` + dupText(res.dup), dupKb(key));
      return;
    }
    const ok = res.saved.length || res.debts?.length;
    if (ok && uniq) await markSaved("v:" + uniq, { f: fileId, m: mime });
    await send(chat, `🎤 <i>«${esc(res.heard)}»</i>\n\n` + (ok ? await savedText(res.saved, res.debts) : "🤔 " + esc(res.reply)), ok ? itemKb(res.saved, res.debts) : mainKb());
  } catch (e) {
    console.error(e);
    await send(chat, "⚠️ Xatolik: " + esc((e as Error).message) + "\n\nOvozni qayta yuboring yoki matn bilan yozing.");
  }
}
async function doText(chat: number, text: string, force = false) {
  if (!force) {
    const key = "t:" + await sha(normText(text));
    const was = await recentDup(key, 30, { t: text });
    if (was) { await send(chat, `⚠️ <b>Xuddi shu yozuv ${hhmm(was)} da yozilgan.</b>\n<i>«${esc(text.slice(0, 200))}»</i>\n\nYana bir marta yozaymi?`, dupKb(key)); return; }
  }
  await tg("sendChatAction", { chat_id: chat, action: "typing" });
  try {
    const res: Row = await saveFromText(text, "tg_text", force);
    if (res.dup) {
      const key = "t:" + await sha(normText(text));
      await db.from("xr_seen").upsert({ key, val: { t: text } });
      await send(chat, dupText(res.dup), dupKb(key));
      return;
    }
    const ok = res.saved.length || res.debts?.length;
    if (ok) await markSaved("t:" + await sha(normText(text)), { t: text });
    await send(chat, ok ? await savedText(res.saved, res.debts) : "🤔 " + esc(res.reply), ok ? itemKb(res.saved, res.debts) : mainKb());
  } catch (e) {
    console.error(e);
    await send(chat, "⚠️ Xatolik: " + esc((e as Error).message));
  }
}
function dupText(d: Row) {
  const items = [
    ...d.rows.map((r: Row) => `${icon(r)} ${what(r)} — <b>${fmt(r.amount)}</b>`),
    ...d.drows.map((x: Row) => `📒 ${esc(x.person)} — <b>${fmt(x.amount)}</b>`),
  ].join("\n");
  return `⚠️ <b>Bular ${d.at ? hhmm(d.at) + " da" : "hozirgina"} yozilgan edi:</b>\n${items}\n\nIkki marta yozilmasligi uchun saqlamadim. Yana yozaymi?`;
}

/* --- 📈 Do'kon holati: foydami, zararmi, qayerga ketyapti --- */
const isHealthQ = (t: string) => !/\d/.test(t) && /foyda|zarar|holat|minus|plyus|qayerga|ketyapti|daromad|yutyap|yutqaz|qanday ketyap|ahvol/i.test(t);
const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);
// hisob yuritish boshlangan kun (birinchi yozuv): undan oldingi kunlar «savdo yozilmagan» deb sanalmaydi
let START = "";
async function loadStart() {
  const { data } = await db.from("xr_expenses").select("spent_on").order("spent_on", { ascending: true }).limit(1);
  START = data?.[0]?.spent_on ?? "";
  return START;
}
function calcHealth(rows: Row[], a: string, b: string) {
  if (START && a < START) a = START;
  const rs = rows.filter((r) => r.spent_on >= a && r.spent_on <= b);
  const S = (k: string) => total(rs.filter((r) => r.kind !== "savdo" && r.scope === k));
  const sv = total(rs.filter((r) => r.kind === "savdo")), shop = S("dokon"), me = S("shaxsiy"), kom = S("kommunal");
  const per: Row[] = [];
  for (let d = a; d <= b && d <= today(); d = nextDay(d)) {
    const x = rs.filter((r) => r.spent_on === d);
    const s = total(x.filter((r) => r.kind === "savdo")), e = total(x.filter((r) => r.kind !== "savdo" && r.scope === "dokon"));
    per.push({ d, s, e, p: s - e });
  }
  const byCat: Record<string, number> = {};
  rs.filter((r) => r.kind !== "savdo" && r.scope === "dokon").forEach((r) => { byCat[r.cat] = (byCat[r.cat] ?? 0) + Number(r.amount); });
  const top = Object.entries(byCat).sort((x, y) => y[1] - x[1])[0];
  return {
    sv, shop, me, kom, foyda: sv - shop, qoldi: sv - shop - me - kom, per, n: per.length,
    salesDays: per.filter((p) => p.s > 0).length, good: per.filter((p) => p.s > 0 && p.p >= 0).length,
    bad: per.filter((p) => p.s > 0 && p.p < 0).length, missing: per.filter((p) => p.s === 0 && p.d < today()).length, top,
  };
}
async function healthReport(range = "month") {
  await loadStart();
  const t = today(), ms = monthStart();
  const prevStart = new Date(Date.parse(ms + "T00:00:00Z") - 864e5).toISOString().slice(0, 8) + "01";
  const [{ data }, drs] = await Promise.all([
    db.from("xr_expenses").select("kind,scope,cat,amount,spent_on").gte("spent_on", prevStart < dAgo(13) ? prevStart : dAgo(13)).limit(10000),
    debtRows(),
  ]);
  const rows = data ?? [];
  const [a, b, titleH] = range === "prev" ? rangeOf("prev") : range === "week" ? rangeOf("week") : [ms, t, rangeOf("month")[2]];
  const h = calcHealth(rows, a, b);
  const w1 = calcHealth(rows, dAgo(6), t), w0 = calcHealth(rows, dAgo(13), dAgo(7));
  const title = plainTitle(titleH);
  const ok = h.foyda >= 0;
  let x = `📈 <b>Do'kon holati</b> · ${esc(title)}\n\n`;
  if (!h.sv && !h.shop) x += "📭 Bu davrda savdo ham, do'kon xarajati ham yozilmagan.\n";
  else {
    x += ok ? `🟢 <b>Do'kon FOYDADA</b>\n` : `🔴 <b>Do'kon ZARARDA</b>\n`;
    x += `💰 Savdo                <b>${fmt(h.sv)}</b>\n🏪 Do'kon xarajati  <b>−${fmt(h.shop)}</b>\n`;
    x += `${ok ? "✅" : "🔻"} <b>${ok ? "Foyda" : "Zarar"}: ${som(Math.abs(h.foyda))}</b>${h.sv ? ` · ${Math.round((h.foyda / h.sv) * 100)}%` : ""}\n`;
    x += `\n👤 Shaxsiy −${fmt(h.me)} · 🧾 Kommunal −${fmt(h.kom)}\n💼 <b>Qo'lda qoldi: ${som(h.qoldi)}</b>\n`;
  }
  // yo'nalish
  const ps = pct(w1.sv, w0.sv), pe = pct(w1.shop, w0.shop), pf = w1.foyda - w0.foyda;
  if (!w0.n || (!w0.sv && !w0.shop)) x += `\n🧭 <b>Qayerga ketyapti?</b> — hisob yangi boshlangan, haftalik solishtirma ${w0.n ? "oldingi hafta ma'lumoti yig'ilgach" : "7 kundan keyin"} chiqadi.\n`;
  else {
    const arrow = (v: number | null) => v === null ? "—" : v > 0 ? `⬆️ ${v}%` : v < 0 ? `⬇️ ${-v}%` : "➡️ 0%";
    x += `\n🧭 <b>Qayerga ketyapti?</b> <i>(oxirgi 7 kun)</i>\nSavdo ${arrow(ps)} · Xarajat ${arrow(pe)}\n`;
    x += pf > 0 ? "→ <b>Yaxshi tomonga</b> ketyapti 👍\n" : pf < 0 ? "→ <b>Yomon tomonga</b> ketyapti ⚠️\n" : "→ O'zgarish yo'q\n";
  }
  // taxmin
  if (range === "month" && h.n >= 3 && h.salesDays) {
    const dim = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7), 0)).getUTCDate();
    const proj = (h.foyda / h.n) * dim;
    x += `\n🔮 Shu tezlikda oy oxirigacha: <b>${proj >= 0 ? "+" : "−"}${short(Math.abs(proj))}</b> ${proj >= 0 ? "foyda" : "zarar"}\n`;
  }
  if (h.salesDays) x += `📅 Foydali kun: <b>${h.good}</b> · Zararli kun: <b>${h.bad}</b>\n`;
  const ppl = debtPeople(drs), myDebt = ppl.filter((p) => p.dir === "out" && p.bal > 0).reduce((s, p) => s + p.bal, 0), theirs = ppl.filter((p) => p.dir === "in" && p.bal > 0).reduce((s, p) => s + p.bal, 0);
  if (myDebt || theirs) x += `📒 Qarzlar: menga ${short(theirs)} · mendan ${short(myDebt)}\n`;
  // maslahat
  const tips: string[] = [];
  if (h.missing > 0) tips.push(`${h.missing} kun savdo yozilmagan. Har kuni kechqurun «bugungi savdo …» deb ayting — shunda foyda aniq chiqadi.`);
  if (!ok && h.top) tips.push(`Eng katta do'kon xarajati: ${CATS.dokon[h.top[0]]?.[1] ?? h.top[0]} (${short(h.top[1])}).`);
  if (ps !== null && ps <= -10) tips.push(`Savdo oldingi haftaga nisbatan ${-ps}% kamaydi.`);
  if (h.foyda > 0 && h.me + h.kom > h.foyda * 0.6) tips.push(`Shaxsiy va kommunal xarajatlar foydaning ${Math.round(((h.me + h.kom) / h.foyda) * 100)}% ini olyapti.`);
  if (myDebt > 0 && h.qoldi > 0 && myDebt > h.qoldi * 2) tips.push(`Qarzingiz (${short(myDebt)}) qo'lda qolgan puldan ancha ko'p.`);
  if (!tips.length && ok) tips.push("Yaxshi ketyapsiz! Shu tartibda davom eting 💪");
  x += `\n💡 <b>Maslahat:</b>\n` + tips.slice(0, 3).map((s) => `• ${esc(s)}`).join("\n");
  // grafik: kunlik foyda (yashil/qizil) + jami (ko'k chiziq)
  let cum = 0;
  const per = h.per, cumArr = per.map((p) => (cum += p.p));
  const chart = per.length > 1 && (h.sv || h.shop) ? chartUrl(JSON.stringify({
    type: "bar",
    data: {
      labels: per.map((p) => `${+p.d.slice(8)}.${p.d.slice(5, 7)}`),
      datasets: [
        { type: "line", label: "Jami foyda", data: cumArr, borderColor: C_BLUE, backgroundColor: "rgba(43,108,246,.08)", borderWidth: 3, pointRadius: 0, fill: true, lineTension: 0.3 },
        { type: "bar", label: "Kunlik", data: per.map((p) => p.p), backgroundColor: per.map((p) => (p.p >= 0 ? C_GREEN : C_RED)) },
      ],
    },
    options: {
      title: { display: true, text: `Do'kon foydasi · ${title}`, fontSize: 18, fontColor: "#101828", fontStyle: "bold" },
      legend: { position: "bottom", labels: { fontSize: 13, boxWidth: 13 } },
      plugins: { datalabels: { display: false } },
      scales: {
        xAxes: [{ gridLines: { display: false }, ticks: { fontColor: "#8a94a6", fontSize: 11 } }],
        yAxes: [{ gridLines: { color: "#eef1f5", zeroLineColor: "#98a2b3", zeroLineWidth: 2 }, ticks: { fontColor: "#8a94a6", fontSize: 11, callback: "__K__" } }],
      },
    },
  }).replace('"__K__"', `function(v){var a=Math.abs(v),s=v<0?'-':'';return a>=1e6?s+(a/1e6).toFixed(a%1e6?1:0)+' mln':a>=1e3?s+Math.round(a/1e3)+'k':v}`), 860, 440) : null;
  return { text: x, chart, h };
}
const holatKb = (cur: string) => ({ inline_keyboard: [
  [["week", "7 kun"], ["month", "Shu oy"], ["prev", "O'tgan oy"]].map(([k, l]) => ({ text: `${k === cur ? "✓ " : ""}${l}`, callback_data: `hl:${k}` })),
  [{ text: "🧑‍🏫 Ustoz tahlili", callback_data: "us:" }, { text: "📄 PDF hisobot", callback_data: `pdf:${cur}` }],
  [{ text: "📱 Ilovada ko'rish", web_app: { url: appUrl() } }],
] });
async function sendHealth(chat: number, range = "month", msg?: Row) {
  const { text, chart } = await healthReport(range);
  const kb = holatKb(range);
  if (msg) await tg("deleteMessage", { chat_id: chat, message_id: msg.message_id });
  if (chart && text.length <= 1024) {
    const r = await tg("sendPhoto", { chat_id: chat, photo: chart, caption: text, parse_mode: "HTML", reply_markup: kb });
    if (r.ok) return;
  } else if (chart) {
    await tg("sendPhoto", { chat_id: chat, photo: chart });
  }
  await send(chat, text, kb);
}

/* --- 📦 Revizya: tovar qoldig'i va kassa --- */
const REV_GUIDE = `📦 <b>Revizya — qadam-baqadam</b> <i>(ustoz yo'riqnomasi)</i>

<b>1. Savdoni to'xtating.</b> Revizya ertalab ochilishdan oldin yoki kechqurun yopilgandan keyin qilinadi — sanash paytida tovar kirib-chiqmasin.
<b>2. Kassani sanang.</b> Naqd pul + terminal/karta tushumi. Bu — <i>kassa qoldig'i</i>.
<b>3. Har bir tovarni sanang.</b> Nomi · soni · <b>KIRIM narxi</b> (firmadan olgan narxingiz). Sotuv narxi bilan emas! Buxgalteriyada qoldiq <i>tannarx</i> bo'yicha hisoblanadi.
<b>4. Yaroqsizini ajrating.</b> Muddati o'tgan, singan, buzilgan tovar — alohida ro'yxat. Bu <i>hisobdan chiqarish</i> (spisaniye) — zarar sifatida yoziladi.
<b>5. Jamini hisoblang.</b> Tovar qoldig'i = Σ (soni × kirim narxi).
<b>6. Qarzlarni tekshiring.</b> Kim sizdan nasiya olgan va siz firmalarga qancha qarzsiz — 📒 Qarzlar bo'limi bilan solishtiring.
<b>7. Natijani yozing</b> — botga shunday yuboring:
<code>revizya: tovar 45 mln, kassa 3 mln</code>

🧮 <b>Nega bu muhim?</b> Tovar xaridi hali zarar emas — sotilmagan tovar polkada pul bo'lib turadi. Haqiqiy foyda ikki revizya orasida chiqadi:
<b>Sotilgan tovar tannarxi</b> = oldingi qoldiq + xaridlar − hozirgi qoldiq
<b>Yalpi foyda</b> = savdo − sotilgan tovar tannarxi
<b>Sof foyda</b> = yalpi foyda − do'kon xarajatlari (ijara, oylik, yo'l…)

📅 Har oy <b>bir xil kunda</b> revizya qiling — shunda oyma-oy solishtirish aniq bo'ladi.`;
const isRevizya = (t: string) => /^\s*(revizya|reviziya|reviziy|ревизия|qoldiq)\b/i.test(t);
function parseRevizya(t: string) {
  let stock = 0, cash = 0;
  for (const seg of t.replace(/^\s*\S+\s*:?/, "").split(/[,;\n]|\bva\b/i)) {
    const v = parseSum(seg);
    if (!v) continue;
    if (/kassa|naqd|pul|karta|terminal|касса/i.test(seg)) cash += v;
    else stock += v;
  }
  return { stock, cash };
}
async function revizyaCalc(cur: Row) {
  const { data: prevs } = await db.from("xr_revizya").select("*").lt("done_on", cur.done_on).order("done_on", { ascending: false }).limit(1);
  const p = prevs?.[0];
  let x = `📦 <b>Revizya yozildi</b> · ${dateUz(cur.done_on)}\n🏬 Tovar qoldig'i: <b>${som(cur.stock)}</b>\n💵 Kassa: <b>${som(cur.cash)}</b>\n`;
  if (!p) {
    x += `\n🧑‍🏫 <b>Ustoz:</b> bu — <b>boshlang'ich nuqta</b>. Endi har kungi savdo va xaridlarni yozib boring. Keyingi revizyada (masalan, oy oxirida) bot <b>haqiqiy foydani</b> hisoblab beradi:\n<i>tannarx = ${short(cur.stock)} + xaridlar − yangi qoldiq</i>`;
    return { text: x, p: null };
  }
  const { data } = await db.from("xr_expenses").select("kind,scope,cat,amount,spent_on").gt("spent_on", p.done_on).lte("spent_on", cur.done_on).limit(10000);
  const rows = data ?? [];
  const sales = total(rows.filter((r) => r.kind === "savdo"));
  const buy = total(rows.filter((r) => r.kind !== "savdo" && r.scope === "dokon" && (r.cat === "tovar" || r.cat === "firma")));
  const opex = total(rows.filter((r) => r.kind !== "savdo" && r.scope === "dokon" && r.cat !== "tovar" && r.cat !== "firma"));
  const other = total(rows.filter((r) => r.kind !== "savdo" && r.scope !== "dokon"));
  const cogs = Number(p.stock) + buy - Number(cur.stock);
  const gross = sales - cogs, net = gross - opex;
  const days = Math.max(1, Math.round((Date.parse(cur.done_on) - Date.parse(p.done_on)) / 864e5));
  x += `\n📊 <b>${dateUz(p.done_on)} → ${dateUz(cur.done_on)}</b> (${days} kun)\n`;
  x += `Oldingi qoldiq ${fmt(p.stock)} + xaridlar ${fmt(buy)} − hozirgi ${fmt(cur.stock)}\n= <b>Sotilgan tovar tannarxi: ${som(cogs)}</b>\n\n`;
  x += `💰 Savdo: <b>${som(sales)}</b>\n${gross >= 0 ? "🟢" : "🔴"} Yalpi foyda: <b>${som(gross)}</b>${sales ? ` (marja ${Math.round((gross / sales) * 100)}%)` : ""}\n`;
  if (cogs > 0) x += `🏷 O'rtacha ustama: <b>${Math.round((gross / cogs) * 100)}%</b>\n`;
  x += `🏪 Do'kon xarajatlari: −${fmt(opex)}\n${net >= 0 ? "✅" : "🔻"} <b>Sof foyda: ${som(net)}</b>\n`;
  const expCash = Number(p.cash) + sales - buy - opex - other;
  const diff = Number(cur.cash) - expCash;
  x += `\n💵 Kassa kutilgan: ${fmt(expCash)} · bor: ${fmt(cur.cash)} → ${Math.abs(diff) < 1000 ? "✅ to'g'ri" : diff < 0 ? `⚠️ <b>kamomad ${som(-diff)}</b>` : `ortiqcha ${som(diff)}`}\n`;
  x += `<i>(Kassa hisobi taxminiy: hamma kirim-chiqim yozilgan bo'lsagina aniq chiqadi)</i>`;
  if (cogs < 0) x += `\n⚠️ Tannarx manfiy chiqdi — demak, ba'zi xaridlar yozilmagan yoki qoldiq noto'g'ri sanalgan.`;
  else if (sales && gross / sales < 0.08) x += `\n⚠️ Marja juda past (8% dan kam) — narxlarni yoki yo'qotishlarni tekshiring.`;
  return { text: x, p };
}
async function saveRevizya(stock: number, cash: number, raw: string | null, note: string | null = null) {
  const { data, error } = await db.from("xr_revizya").insert({ done_on: today(), stock, cash, raw, note }).select().single();
  if (error) throw error;
  return data;
}

/* --- 🧑‍🏫 Ustoz-buxgalter --- */
const U_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
const USTOZ = `Sen — 20 yillik tajribaga ega bosh buxgalter va kichik savdo (oziq-ovqat, mayda chakana do'kon) bo'yicha moliyaviy maslahatchisan. O'zbekistonda ishlaysan. Foydalanuvchi — do'kon egasi, sening shogirding. U do'konini "tiriltirmoqchi". Ustoz kabi gapir: samimiy, lekin aniq, talabchan va amaliy.

QOIDALAR:
1. Faqat berilgan MA'LUMOTLAR dagi raqamlarga tayan. Raqam o'ylab topma. Ma'lumot yetishmasa — buni ochiq ayt va uni qanday yig'ishni o'rgat.
2. Har bir fikrda: (a) nima uchun — qisqa tushuntirish; atama ishlatsang oddiy so'z bilan izohla (masalan: marja, ustama/natsenka, tannarx, aylanma mablag', pul oqimi, revizya, kamomad, hisobdan chiqarish); (b) foydalanuvchining o'z raqamlari bilan hisob; (c) aniq harakat.
3. Asosiy haqiqat: tovar xaridi darhol zarar EMAS — sotilmagan tovar polkada pul bo'lib turadi. Haqiqiy foyda = Savdo − Sotilgan tovar tannarxi − Do'kon xarajatlari. Sotilgan tovar tannarxi = boshlang'ich qoldiq + xaridlar − oxirgi qoldiq (revizya orqali). Agar revizya bo'lmasa, "Savdo − do'kon xarajati" faqat pul oqimini ko'rsatishini tushuntir.
4. Agar savdo hamma kunlar uchun yozilmagan bo'lsa — xulosalar ishonchsiz ekanini birinchi navbatda ayt.
5. Kerak bo'lsa o'rgat: shaxsiy pulni do'kon kassasidan ajratish (o'ziga oylik belgilash), kunlik kassa daftari, nasiyaga chegara va muddat, firmaga qarzni rejalashtirish, tez va sekin sotiladigan tovar (ABC tahlil), yaroqlilik muddati nazorati, o'g'irlik/yo'qotishni kamaytirish.
6. Soliq stavkalari, qonun moddalari va jarimalar haqida aniq raqam AYTMA — "soliq inspeksiyasi yoki litsenziyali buxgalter bilan aniqlang (my.soliq.uz)" deb yo'naltir.
7. Format Telegram uchun: qisqa bandlar, bo'lim sarlavhalarini **qalin** qil, ro'yxat uchun "•" ishlat. Jadval, # belgisi, havola ishlatma. Javob o'zbek lotin yozuvida, sodda tilda.`;
async function ustozContext() {
  await loadStart();
  const t = today(), ms = monthStart();
  const [{ data }, drs, { data: rv }] = await Promise.all([
    db.from("xr_expenses").select("kind,scope,cat,amount,spent_on,note,firm").gte("spent_on", dAgo(59)).limit(10000),
    debtRows(),
    db.from("xr_revizya").select("*").order("done_on", { ascending: false }).limit(6),
  ]);
  const rows = data ?? [];
  const m = calcHealth(rows, ms, t), w1 = calcHealth(rows, dAgo(6), t), w0 = calcHealth(rows, dAgo(13), dAgo(7)), d30 = calcHealth(rows, dAgo(29), t);
  const by: Record<string, number> = {};
  rows.filter((r) => r.spent_on >= dAgo(29) && r.kind !== "savdo").forEach((r) => { const k = `${SN[r.scope] ?? r.scope} / ${CATS[r.scope]?.[r.cat]?.[1] ?? r.cat}`; by[k] = (by[k] ?? 0) + Number(r.amount); });
  const firms: Record<string, number> = {};
  rows.filter((r) => r.spent_on >= dAgo(29) && r.firm).forEach((r) => { firms[r.firm] = (firms[r.firm] ?? 0) + Number(r.amount); });
  const ppl = debtPeople(drs).filter((p) => Math.round(p.bal) !== 0);
  const L: string[] = [];
  L.push(`Bugun: ${t}. Foydalanuvchi hisob yuritishni ${START || t} dan boshlagan (${m.n} kun). Undan oldingi kunlar haqida ma'lumot yo'q — ularni "yozilmagan" deb hisoblama. Bugungi savdo odatda kechqurun yoziladi.`);
  L.push(`SHU OY: savdo ${fmt(m.sv)}; do'kon xarajati ${fmt(m.shop)}; shaxsiy ${fmt(m.me)}; kommunal va soliq ${fmt(m.kom)}; savdo − do'kon xarajati = ${fmt(m.foyda)}; qo'lda qoldi ${fmt(m.qoldi)}.`);
  L.push(`Savdo yozilgan kunlar: ${m.salesDays} / ${m.n} (bugundan oldingi yozilmagan kunlar: ${m.missing}).`);
  L.push(`OXIRGI 30 KUN: savdo ${fmt(d30.sv)}, do'kon xarajati ${fmt(d30.shop)}, shaxsiy ${fmt(d30.me)}, kommunal ${fmt(d30.kom)}, savdo yozilgan kun ${d30.salesDays}/${d30.n}.`);
  L.push(`OXIRGI 7 KUN: savdo ${fmt(w1.sv)}, do'kon xarajati ${fmt(w1.shop)}. ${w0.n ? `OLDINGI 7 KUN: savdo ${fmt(w0.sv)}, do'kon xarajati ${fmt(w0.shop)}.` : "OLDINGI 7 KUN: ma'lumot yo'q (hisob yangi boshlangan) — haftalik solishtirma qilma."}`);
  L.push(`XARAJAT TURLARI (30 kun): ` + (Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(v)}`).join("; ") || "yo'q"));
  if (Object.keys(firms).length) L.push(`FIRMALARGA TO'LOV (30 kun): ` + Object.entries(firms).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(v)}`).join("; "));
  L.push(`QARZLAR: ` + (ppl.length ? ppl.map((p) => `${p.name} — ${p.dir === "in" ? "menga qarzdor" : "men qarzdorman"} ${fmt(p.bal)}`).join("; ") : "yo'q"));
  L.push(`REVIZYALAR: ` + ((rv ?? []).length ? (rv ?? []).map((r: Row) => `${r.done_on}: tovar qoldig'i ${fmt(r.stock)}, kassa ${fmt(r.cash)}`).join("; ") : "hali bitta ham revizya qilinmagan"));
  return L.join("\n");
}
const tgFormat = (s: string) => esc(s.slice(0, 3500).replace(/^#+\s*/gm, "")).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^\s*[*-]\s+/gm, "• ").replace(/\*(?!\s)([^*\n]+?)\*/g, "<i>$1</i>");
async function ustoz(question = ""): Promise<string> {
  await cfg();
  if (!GEMINI_KEY) throw new Error("Gemini kaliti yo'q");
  const ctx = await ustozContext();
  const task = question
    ? `Shogirdingning savoli: "${question.slice(0, 800)}"\nShu savolga ustoz sifatida, uning raqamlariga tayanib javob ber. 1500 belgidan oshirma. Oxirida 1-2 ta aniq qadam yoz.`
    : `Do'konni to'liq tahlil qil, xuddi tajribali buxgalter auditdan keyin egasiga tushuntirgandek. Tuzilma:\n**Tashxis** — do'kon hozir qanday ahvolda (2-3 gap, ma'lumot to'liqligini ham ayt)\n**Raqamlar nima deydi** — 3-5 ta asosiy topilma, har biri hisob bilan\n**Bugun o'rganadigan qoidang** — bitta muhim buxgalteriya bilimi, misol bilan\n**Revizya** — bugun revizya qilayotgan bo'lsa nimaga e'tibor berish kerak (shu do'kon raqamlariga bog'lab)\n**Bugungi 3 ta vazifa** — aniq, o'lchanadigan\n2800 belgidan oshirma.`;
  const txt = await gemini({
    system_instruction: { parts: [{ text: USTOZ }] },
    contents: [{ role: "user", parts: [{ text: `MA'LUMOTLAR:\n${ctx}\n\nVAZIFA:\n${task}` }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
  }, U_MODELS, 512);
  return txt.trim();
}
const ustozKb = () => ({ inline_keyboard: [
  [{ text: "🔄 Yangi tahlil", callback_data: "us:" }, { text: "📦 Revizya yo'riqnomasi", callback_data: "rv:" }],
  [{ text: "📈 Do'kon holati", callback_data: "hl:month" }],
] });
async function sendUstoz(chat: number, question = "") {
  const wait = await tg("sendMessage", { chat_id: chat, text: "🧑‍🏫 <i>Ustoz raqamlaringizni ko'rib chiqyapti…</i>", parse_mode: "HTML" });
  await tg("sendChatAction", { chat_id: chat, action: "typing" });
  try {
    const a = await ustoz(question);
    const text = `🧑‍🏫 <b>Ustoz-buxgalter</b>${question ? `\n<i>«${esc(question.slice(0, 120))}»</i>` : ""}\n\n${tgFormat(a)}\n\n<i>Savol bering: «ustoz, …» deb yozing</i>`;
    const r = await tg("editMessageText", { chat_id: chat, message_id: wait.result?.message_id, text, parse_mode: "HTML", reply_markup: ustozKb() });
    if (!r.ok) await send(chat, text, ustozKb());
  } catch (e) {
    console.error(e);
    await tg("editMessageText", { chat_id: chat, message_id: wait.result?.message_id, text: "⚠️ Ustoz hozir javob bera olmadi: " + esc((e as Error).message) + "\nBirozdan keyin qayta urinib ko'ring." });
  }
}
async function sendRevizyaGuide(chat: number) {
  const { data: rv } = await db.from("xr_revizya").select("*").order("done_on", { ascending: false }).limit(3);
  let t = REV_GUIDE;
  if (rv?.length) t += `\n\n🗂 <b>Oxirgi revizyalar:</b>\n` + rv.map((r: Row) => `${dateUz(r.done_on)} — tovar ${fmt(r.stock)} · kassa ${fmt(r.cash)}`).join("\n");
  await send(chat, t, { inline_keyboard: [[{ text: "🧑‍🏫 Ustoz tahlili", callback_data: "us:" }]] });
}

/* --- har kuni kechqurun avtomatik hisobot --- */
async function eveningPost() {
  const [{ all }, drs] = await Promise.all([rangeRows("today"), debtRows()]);
  const ppl = debtPeople(drs);
  const bal = (d: string) => ppl.filter((p) => p.dir === d && Math.round(p.bal) > 0).reduce((a, p) => a + p.bal, 0);
  let post = "";
  if (!all.some((r) => r.kind === "savdo")) post += `\n\n⚠️ <b>Bugungi savdo hali yozilmagan.</b>\nAyting: <i>«bugungi savdo 2 mln 500 ming»</i>`;
  try {
    const { h } = await healthReport("month");
    if (h.sv || h.shop) post += `\n\n📈 Shu oy: do'kon <b>${h.foyda >= 0 ? "foydada +" + fmt(h.foyda) : "zararda −" + fmt(-h.foyda)}</b> · batafsil: /holat`;
  } catch (e) { console.error(e); }
  const bi = bal("in"), bo = bal("out");
  if (bi || bo) post += `\n\n📒 Menga qarzdor: <b>${fmt(bi)}</b>\n📒 Mening qarzim: <b>${fmt(bo)}</b>`;
  return post;
}
async function evening(chat: number) {
  await sendReport(chat, "today", undefined, "🌙 <b>Kun yakuni</b>\n\n", await eveningPost());
}

const HELP = `💡 <b>Qanday ishlatiladi</b>

Oddiy gap bilan <b>yozing</b> yoki <b>🎤 ovozli xabar</b> yuboring:

💸 <b>Xarajat</b>
• <i>Svetga 250 ming to'ladim</i>
• <i>Coca-Cola firmasiga 3 mln, sigaretga 585 ming</i>
• <i>Uyga bozorlik 185 ming</i> → 👤 shaxsiy

💰 <b>Savdo</b>
• <i>Bugungi savdo 3 mln 200 ming</i>

📒 <b>Qarz / nasiya</b>
• <i>Alisher 85 ming nasiya oldi</i>
• <i>Dilnoza opa 40 mingini qaytardi</i>
• <i>Karim akadan 2 mln nasiyaga tovar oldim</i>

🗂 <b>3 ta bo'lim</b> — bot o'zi ajratadi:
🏪 <b>Do'kon</b> — tovar, yuk, firma, ijara, oylik
👤 <b>Shaxsiy</b> — <i>«dadamga pul berdim»</i>, <i>«shashlik yedim»</i>, kiyim, taksi
🧾 <b>Kommunal va soliq</b> — svet, gaz, suv, soliq
Noto'g'ri bo'limga tushsa, yozuv ostidagi «→» tugmasi bilan ko'chiring yoki 🗑 bilan o'chiring.

📈 <b>Do'kon holati</b> — foydadami, zarardami, qayerga ketyapti: /holat
Yoki shunchaki so'rang: <i>«do'kon foydadami?»</i>, <i>«qayerga ketyapmiz?»</i>

🧑‍🏫 <b>Ustoz-buxgalter</b> — raqamlaringizni tahlil qilib o'rgatadi: /ustoz
Savol bering: <i>«ustoz, narxni qanday qo'yay?»</i>

📦 <b>Revizya</b> — yo'riqnoma: /revizya · natija: <i>«revizya: tovar 45 mln, kassa 3 mln»</i>

📄 <b>PDF hisobot</b> — barcha statistika va yozuvlar bitta faylda: /pdf
Bir xil xabar ikki marta kelsa, bot so'rab oladi — ikki marta yozilmaydi.

🌙 Har kuni soat 21:00 da kun yakuni keladi (o'chirish: /kechki).

📅 Bugun · 📊 Hisobot · 📈 Holat · 🧑‍🏫 Ustoz · 📦 Revizya · 📒 Qarzlar · 📄 PDF`;

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
    }
  }
  if (!owner || String(from.id) !== owner) {
    if (upd.message) await tg("sendMessage", { chat_id: from.id, text: "🔒 Bu shaxsiy bot. Kirish yopiq." });
    else await tg("answerCallbackQuery", { callback_query_id: upd.callback_query.id, text: "🔒 Kirish yopiq" });
    return;
  }
  const chat = Number(from.id);
  if (upd.update_id && !(await firstTime("u:" + upd.update_id))) { console.log("takroriy update", upd.update_id); return; }
  await ensureAppToken();

  // --- inline tugmalar ---
  if (upd.callback_query) {
    const q = upd.callback_query, msg = q.message;
    const [act, arg, arg3] = String(q.data ?? "").split(":");
    const ack = (text?: string) => tg("answerCallbackQuery", { callback_query_id: q.id, text });
    if (act === "rep") { await ack(); await sendReport(chat, arg, msg); return; }
    if (act === "no") { await ack("Yozilmadi"); await tg("deleteMessage", { chat_id: chat, message_id: msg.message_id }); return; }
    if (act === "ag") {
      const key = String(q.data).slice(3);
      const { data: s } = await db.from("xr_seen").select("val").eq("key", key).maybeSingle();
      await ack();
      await tg("deleteMessage", { chat_id: chat, message_id: msg.message_id });
      if (!s?.val) { await send(chat, "Xabar topilmadi, qaytadan yuboring."); return; }
      if (s.val.f) await doVoice(chat, s.val.f, s.val.m, true);
      else if (s.val.t) await doText(chat, s.val.t, true);
      return;
    }
    if (act === "rd") { await ack(); await send(chat, await reportText(arg)); return; }
    if (act === "us") { await ack("🧑‍🏫 Ustoz o'ylayapti…"); await sendUstoz(chat); return; }
    if (act === "rv") { await ack(); await sendRevizyaGuide(chat); return; }
    if (act === "rvd") {
      const { data: rr } = await db.from("xr_revizya").select("*").eq("id", Number(arg)).maybeSingle();
      if (!rr) { await ack("Allaqachon o'chirilgan"); return; }
      await db.from("xr_revizya").delete().eq("id", rr.id);
      await ack("🗑 O'chirildi");
      await send(chat, `🗑 Revizya o'chirildi: ${dateUz(rr.done_on)} · tovar ${fmt(rr.stock)}`);
      return;
    }
    if (act === "hl") { await ack(); await sendHealth(chat, ["week", "month", "prev"].includes(arg) ? arg : "month", (msg?.caption ?? msg?.text ?? "").startsWith("📈") ? msg : undefined); return; }
    if (act === "pdf") {
      await ack("📄 PDF tayyorlanmoqda…");
      try { await sendPdf(chat, PDF_R.some(([k]) => k === arg) || arg === "yday" ? arg : "month"); }
      catch (e) { console.error(e); await send(chat, "⚠️ " + esc((e as Error).message)); }
      return;
    }
    if (act === "dt") {
      await ack();
      const v = await debtsView(arg);
      if (msg.photo) { await tg("deleteMessage", { chat_id: chat, message_id: msg.message_id }); await send(chat, v.t, v.kb); }
      else await tg("editMessageText", { chat_id: chat, message_id: msg.message_id, text: v.t, parse_mode: "HTML", reply_markup: v.kb });
      return;
    }
    if (act === "dp") {
      const v = await personView(Number(arg));
      if (!v) { await ack("Topilmadi"); return; }
      await ack();
      await tg("editMessageText", { chat_id: chat, message_id: msg.message_id, text: v.t, parse_mode: "HTML", reply_markup: v.kb });
      return;
    }
    if (act === "dl") {
      const { data: d } = await db.from("xr_debts").select("*").eq("id", Number(arg)).maybeSingle();
      if (!d) { await ack("Allaqachon o'chirilgan"); return; }
      await db.from("xr_debts").delete().eq("id", d.id);
      await ack("🗑 O'chirildi");
      await send(chat, `🗑 O'chirildi: ${d.dir === "in" ? "🟢" : "🔴"} ${esc(d.person)} ${KL[d.dir][d.kind]} ${fmt(+d.amount)}`);
      return;
    }
    const id = Number(arg);
    const { data: r } = await db.from("xr_expenses").select("*").eq("id", id).maybeSingle();
    if (!r) { await ack("Allaqachon o'chirilgan"); return; }
    if (act === "del") {
      await db.from("xr_expenses").delete().eq("id", id);
      await ack("🗑 O'chirildi");
      await send(chat, `🗑 O'chirildi: ${icon(r)} ${what(r)} — ${fmt(+r.amount)}`);
    } else if ((act === "mv" || act === "sw") && r.kind !== "savdo") {
      // boshqa bo'limga o'tkazish, keyin turini tanlash
      const to = act === "mv" && SCOPES.includes(arg3) ? arg3 : r.scope === "dokon" ? "shaxsiy" : "dokon";
      const cat = swapCat(to, r.cat);
      await db.from("xr_expenses").update({ scope: to, cat, firm: to === "dokon" ? r.firm : null }).eq("id", id);
      await ack(`${SCOPE[to]} ga o'tkazildi`);
      await send(chat, `🔁 <b>${SCOPE[to]}</b> ga o'tkazildi\n${line({ ...r, scope: to, cat })}\n\nTurini tanlang:`, catKb(id, to, cat));
    } else if (act === "ct" && r.kind !== "savdo" && CATS[r.scope]?.[arg3]) {
      await db.from("xr_expenses").update({ cat: arg3 }).eq("id", id);
      await ack(`✅ ${CATS[r.scope][arg3][1]}`);
      await tg("editMessageText", { chat_id: chat, message_id: msg.message_id, parse_mode: "HTML", text: `✅ ${SCOPE[r.scope]} · ${line({ ...r, cat: arg3 })}`, reply_markup: itemKb([{ ...r, cat: arg3 }]) });
    }
    return;
  }

  const m = upd.message;
  const text: string = (m.text ?? m.caption ?? "").trim();
  console.log("tg msg:", m.voice ? "[voice]" : text.slice(0, 80));
  const start = async () => {
    await tg("setChatMenuButton", { chat_id: chat, menu_button: { type: "web_app", text: "Ilova", web_app: { url: appUrl() } } });
    return send(chat, `Assalomu alaykum, <b>${esc(from.first_name ?? "")}</b>! 👋\n\nMen sizning <b>hisobchingizman</b>: xarajat, savdo va qarzlarni yozib boraman 📒\n\n` + HELP);
  };
  const menu: Record<string, () => Promise<unknown>> = {
    "/start": start, [B.help]: () => send(chat, HELP), "ℹ️ Yordam": () => send(chat, HELP), "/yordam": () => send(chat, HELP),
    [B.today]: () => sendReport(chat, "today"), "/bugun": () => sendReport(chat, "today"),
    [B.report]: () => sendReport(chat, "month"), "📊 Shu oy": () => sendReport(chat, "month"), "/oy": () => sendReport(chat, "month"),
    "🗓 7 kun": () => sendReport(chat, "week"), "/hafta": () => sendReport(chat, "week"),
    [B.debts]: async () => { const v = await debtsView("in"); return send(chat, v.t, v.kb); }, "/qarzlar": async () => { const v = await debtsView("in"); return send(chat, v.t, v.kb); },
    "🌐 Web sahifa": () => send(chat, "📱 Ilovani ochish uchun pastdagi tugmani bosing 👇", { inline_keyboard: [[{ text: "📱 Ilovani ochish", web_app: { url: appUrl() } }]] }),
    "/web": () => send(chat, "📱 Ilova:", { inline_keyboard: [[{ text: "📱 Ilovani ochish", web_app: { url: appUrl() } }]] }),
    "/kechki": async () => {
      const off = c.evening !== "off";
      await db.from("xr_config").upsert({ key: "evening", value: off ? "off" : "on" });
      await cfg(true);
      return send(chat, off ? "🌙 Kechki hisobot <b>o'chirildi</b>. Qayta yoqish: /kechki" : "🌙 Kechki hisobot <b>yoqildi</b> — har kuni soat 21:00 da keladi.");
    },
    "/kunyakuni": () => evening(chat),
    [B.holat]: () => sendHealth(chat), "/holat": () => sendHealth(chat),
    [B.ustoz]: () => sendUstoz(chat), "/ustoz": () => sendUstoz(chat),
    [B.rev]: () => sendRevizyaGuide(chat), "/revizya": () => sendRevizyaGuide(chat),
    [B.pdf]: () => sendPdf(chat, "month").catch((e) => send(chat, "⚠️ " + esc((e as Error).message))),
    "/pdf": () => sendPdf(chat, "month").catch((e) => send(chat, "⚠️ " + esc((e as Error).message))),
    "/chiqish": async () => {
      await db.from("xr_sessions").delete().neq("token", "");
      await db.from("xr_config").delete().eq("key", "app_token");
      await cfg(true); await ensureAppToken();
      return send(chat, "🔒 Barcha eski havolalar o'chirildi. Ilova tugmasi yangilandi.");
    },
  };
  const cmd = menu[text] ? text : text.startsWith("/") ? text.split(/[@\s]/)[0] : "";
  if (cmd && menu[cmd]) { await menu[cmd](); return; }
  if (text.startsWith("/")) { await send(chat, HELP); return; }

  const voice = m.voice ?? m.audio;
  if (voice) { await doVoice(chat, voice.file_id, voice.mime_type || "audio/ogg", false, voice.file_unique_id ?? ""); return; }
  if (!text) { await send(chat, "Xarajat, savdo yoki qarzni yozing yoki 🎤 ovozli xabar yuboring"); return; }
  // «ustoz, …» — savol ustozga
  const uq = text.match(/^\s*(ustoz|buxgalter|домла|domla)[\s,:!-]*(.*)$/is);
  if (uq) { await sendUstoz(chat, uq[2].trim()); return; }
  // revizya natijasi: «revizya: tovar 45 mln, kassa 3 mln»
  if (isRevizya(text) && /\d/.test(text)) {
    const { stock, cash } = parseRevizya(text);
    if (!stock && !cash) { await send(chat, "Raqamni topmadim. Masalan: <code>revizya: tovar 45 mln, kassa 3 mln</code>"); return; }
    const cur = await saveRevizya(stock, cash, text);
    const { text: rt } = await revizyaCalc(cur);
    await send(chat, rt, { inline_keyboard: [[{ text: "🧑‍🏫 Ustoz tahlili", callback_data: "us:" }, { text: "🗑 O'chirish", callback_data: `rvd:${cur.id}` }]] });
    return;
  }
  if (isRevizya(text)) { await sendRevizyaGuide(chat); return; }
  // savol: «do'kon foydadami?», «zarardamizmi», «qayerga ketyapti» — summa yo'q bo'lsa holatni ko'rsatamiz
  if (isHealthQ(text)) { await sendHealth(chat, /o'tgan oy|otgan oy/i.test(text) ? "prev" : /hafta|7 kun/i.test(text) ? "week" : "month"); return; }
  // raqamsiz savol (?) — ustozga
  if (/\?\s*$/.test(text) && !/\d/.test(text)) { await sendUstoz(chat, text); return; }
  await doText(chat, text);
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
      const [rows, debts] = await Promise.all([rowsFrom(from), debtRows()]);
      return json({ rows, debts, today: today() });
    }
    case "text": {
      const text = String(b.text ?? "").trim();
      if (!text) return json({ error: "Matn bo'sh" }, 400);
      const r = await saveFromText(text, "web_text");
      return json({ saved: r.saved, debts: r.debts ?? [], reply: r.reply });
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
    case "add_debt": {
      const d = cleanDebt(b, null, "web_form");
      if (!d.person) return json({ error: "Ismni kiriting" }, 400);
      if (!(d.amount > 0)) return json({ error: "Summani kiriting" }, 400);
      const { data: ex } = await db.from("xr_debts").select("person").eq("dir", d.dir).limit(2000);
      const mm = (ex ?? []).find((e: Row) => pkey(e.person) === pkey(d.person)); if (mm) d.person = mm.person;
      const { data, error } = await db.from("xr_debts").insert(d).select().single();
      if (error) throw error;
      return json({ debt: data });
    }
    case "ustoz": {
      const q = String(b.q ?? "").trim();
      return json({ text: await ustoz(q) });
    }
    case "revizya_list": {
      const { data } = await db.from("xr_revizya").select("*").order("done_on", { ascending: false }).limit(24);
      return json({ rows: data ?? [] });
    }
    case "revizya_add": {
      const stock = Math.round(Number(b.stock) || 0), cash = Math.round(Number(b.cash) || 0);
      if (stock <= 0) return json({ error: "Tovar qoldig'ini kiriting" }, 400);
      const cur = await saveRevizya(stock, cash, null, String(b.note ?? "").slice(0, 200) || null);
      const { text } = await revizyaCalc(cur);
      return json({ row: cur, text });
    }
    case "revizya_del": {
      await db.from("xr_revizya").delete().eq("id", Number(b.id));
      return json({ ok: true });
    }
    case "pdf_tg": {
      const c = await cfg();
      await sendPdf(Number(c.owner_id), String(b.range ?? "month"));
      return json({ ok: true });
    }
    case "del_debt": {
      await db.from("xr_debts").delete().eq("id", Number(b.id));
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

    // PDF ni brauzerda yuklab olish: /pdf?t=TOKEN&range=month
    if (path.endsWith("/pdf")) {
      const token = url.searchParams.get("t") ?? "";
      const { data: s } = token.length >= 20 ? await db.from("xr_sessions").select("token").eq("token", token).maybeSingle() : { data: null };
      if (!s) return new Response("Kirish yopiq", { status: 401, headers: CORS });
      const range = url.searchParams.get("range") ?? "month";
      const { bytes, name } = await buildPdf(["today", "yday", "week", "month", "prev", "all"].includes(range) ? range : "month");
      return new Response(bytes, { headers: { ...CORS, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"` } });
    }

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
        { command: "qarzlar", description: "Qarz daftari" },
        { command: "holat", description: "Do'kon holati: foyda yoki zarar" },
        { command: "ustoz", description: "Ustoz-buxgalter tahlili va maslahati" },
        { command: "revizya", description: "Revizya yo'riqnomasi va natijani yozish" },
        { command: "kunyakuni", description: "Kun yakuni hozir" },
        { command: "pdf", description: "PDF hisobot yuklab olish" },
        { command: "kechki", description: "21:00 dagi hisobotni yoqish/o'chirish" },
        { command: "web", description: "Ilova" },
        { command: "yordam", description: "Qo'llanma" },
      ] });
      const me = await tg("getMe", {});
      const user = me?.result?.username;
      return json({ missing, hook: hook.ok, bot: user, owner: !!c.owner_id, claim: !c.owner_id && user ? `https://t.me/${user}?start=${c.claim_code}` : null });
    }

    if (path.endsWith("/cron")) {
      const c = await cfg(true);
      if (!c.setup_secret || url.searchParams.get("k") !== c.setup_secret) return new Response("forbidden", { status: 403 });
      if (url.searchParams.get("dry")) {
        const { from, to, title, all } = await rangeRows("today");
        return json({ caption: fitCaption("🌙 <b>Kun yakuni</b>\n\n" + summaryCaption(title, all) + await eveningPost()), photo: all.length ? chartFor("today", all, from, to, plainTitle(title)) : null });
      }
      if (c.evening === "off" || !c.owner_id) return json({ skipped: true });
      await evening(Number(c.owner_id));
      // eski takror-yozuvlarni tozalash (8 kundan eski)
      await db.from("xr_seen").delete().lt("created_at", new Date(Date.now() - 8 * 864e5).toISOString());
      return json({ sent: true });
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
