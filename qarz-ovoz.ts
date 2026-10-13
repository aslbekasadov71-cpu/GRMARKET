// Supabase Edge Function: qarz-ovoz
// Ovozli xabarni (o'zbekcha) matnga aylantiradi va undan qarz yozuvlarini ajratib beradi.
// Kerakli secret: GEMINI_API_KEY (aistudio.google.com -> Get API key). Ixtiyoriy: GEMINI_MODEL
const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PROMPT = `Sen O'zbekistondagi oziq-ovqat do'konining nasiya (qarz) daftarisan.
Audioda do'kon egasi o'zbek tilida (ba'zan rus so'zlari aralash) qarz haqida gapiradi.

1) "transcript": aytilgan gapni aynan, o'zbek lotin yozuvida, imlo xatosiz yoz.
2) "items": har bir alohida qarz/to'lov uchun bitta yozuv:
   - person: odamning ismi (bosh harf bilan, lotin yozuvida). Agar ism quyidagi mavjud ismlardan biriga mos kelsa, aynan o'sha yozilishini ishlat.
   - dir: "in"  = u odam DO'KONGA qarzdor (mijoz nasiyaga mahsulot oldi, qarz oldi, qarzini qaytardi).
          "out" = DO'KON EGASI o'sha odamga qarzdor (optomchi/ta'minotchidan nasiyaga tovar oldim, undan qarz oldim, unga qarzimni to'ladim).
   - kind: "debt" = yangi qarz paydo bo'ldi; "pay" = qarz to'landi/qaytarildi.
   - amount: so'mda butun son. "ellik ming" = 50000, "bir yarim million" = 1500000, "yuz yigirma besh ming" = 125000,
     "ikki yuz ming" = 200000, "85 ming" = 85000, "3 mln" = 3000000, "o'n ming besh yuz" = 10500.
   - phone: aytilgan bo'lsa telefon raqami, aks holda bo'sh.
   - note: qo'shimcha izoh (masalan "non va sut uchun", "ertaga beraman dedi"), bo'lmasa bo'sh.
Misollar:
 "Alisher 85 ming so'mlik nasiya oldi" -> in, debt, 85000
 "Dilnoza opa 40 mingini qaytardi" -> in, pay, 40000
 "Karim akadan 2 million so'mlik tovar nasiyaga oldim" -> out, debt, 2000000
 "Optomchi Rustamga 500 ming to'ladim" -> out, pay, 500000
Agar audio jim yoki qarzga aloqasiz bo'lsa, items bo'sh ro'yxat bo'lsin. Hech narsa to'qib chiqarma.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    transcript: { type: "STRING" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          person: { type: "STRING" },
          dir: { type: "STRING", enum: ["in", "out"] },
          kind: { type: "STRING", enum: ["debt", "pay"] },
          amount: { type: "NUMBER" },
          phone: { type: "STRING" },
          note: { type: "STRING" },
        },
        required: ["person", "dir", "kind", "amount"],
      },
    },
  },
  required: ["transcript", "items"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!KEY) return json({ error: "GEMINI_API_KEY sozlanmagan" });
  try {
    const { audio, mime, text, people } = await req.json();
    if (!audio && !text) return json({ error: "Ovoz yo'q" }, 400);
    if (audio && audio.length > 8_000_000) return json({ error: "Ovoz juda uzun" }, 400);
    const names = Array.isArray(people) ? people.slice(0, 300).map(String).join(", ") : "";
    const parts: unknown[] = [{ text: PROMPT + (names ? `\n\nMavjud ismlar: ${names}` : "") }];
    parts.push(audio ? { inline_data: { mime_type: String(mime || "audio/wav"), data: audio } } : { text: "Matn: " + String(text) });

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
      }),
    });
    const g = await r.json();
    if (!r.ok) return json({ error: "Gemini: " + (g?.error?.message ?? r.status) });
    const out = g?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    const res = JSON.parse(out || "{}");
    const items = (Array.isArray(res.items) ? res.items : []).map((x: Record<string, unknown>) => ({
      person: String(x.person ?? "").trim(),
      dir: x.dir === "out" ? "out" : "in",
      kind: x.kind === "pay" ? "pay" : "debt",
      amount: Math.max(0, Math.round(Number(x.amount) || 0)),
      phone: String(x.phone ?? "").trim(),
      note: String(x.note ?? "").trim(),
    }));
    return json({ transcript: String(res.transcript ?? "").trim(), items });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
