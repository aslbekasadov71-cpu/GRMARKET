"""
Nakladnoy bot: rasm/PDF yuborasiz -> bot tovarlarni o'qiydi -> marja qo'shib sotish narxini chiqaradi.
Bitta rasmda bir nechta nakladnoy/chek bo'lsa ham hammasini ajratib o'qiydi.
"""
import base64
import io
import logging
import math
import os
from datetime import datetime

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandObject
from aiogram.types import BufferedInputFile, Message
from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from PIL import Image

load_dotenv()
logging.basicConfig(level=logging.INFO)

TG_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5")
DEFAULT_MARJA = float(os.getenv("MARJA", "22"))
DEFAULT_STEP = int(os.getenv("YAXLITLASH", "100"))
ALLOWED = {int(x) for x in os.getenv("ALLOWED_USERS", "").replace(" ", "").split(",") if x}

client = AsyncAnthropic()  # ANTHROPIC_API_KEY .env dan olinadi
bot = Bot(TG_TOKEN)
dp = Dispatcher()
settings: dict[int, dict] = {}  # user_id -> {"marja": 22, "step": 100}


def cfg(uid: int) -> dict:
    return settings.setdefault(uid, {"marja": DEFAULT_MARJA, "step": DEFAULT_STEP})


def allowed(m: Message) -> bool:
    return not ALLOWED or (m.from_user and m.from_user.id in ALLOWED)


# ---------- Claude: nakladnoyni o'qish ----------

EXTRACT_TOOL = {
    "name": "save_invoices",
    "description": "Rasmdagi barcha nakladnoy va cheklardan tovarlarni saqlash",
    "input_schema": {
        "type": "object",
        "properties": {
            "invoices": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "supplier": {"type": "string", "description": "Yetkazuvchi / firma / sklad nomi"},
                        "doc_number": {"type": "string"},
                        "date": {"type": "string"},
                        "items": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "qty": {"type": "number", "description": "Soni/Кол-во. O'qib bo'lmasa yoki "
                                                                             "yozilmagan bo'lsa 0 qoldiring."},
                                    "unit": {"type": "string", "description": "dona, karobka, pachka, kg, blok, "
                                                                             "ta ... Og'irlik (kasr son) bo'lsa kg."},
                                    "unit_cost": {
                                        "type": "number",
                                        "description": "1 birlik (dona yoki kg) narxi — Narxi/Цена ustuni. "
                                                       "Chegirma bo'lsa Цена со скидкой ni oling.",
                                    },
                                    "line_sum": {
                                        "type": "number",
                                        "description": "Qator summasi: Summasi/Сумма ustuni yoki '=' dan keyingi "
                                                       "natija. Yozilmagan bo'lsa 0.",
                                    },
                                    "pieces_per_unit": {
                                        "type": "number",
                                        "description": "Faqat birlik karobka/pachka bo'lib, ichidagi dona soni "
                                                       "aniq yozilgan bo'lsa (masalan 'KAROBKA 12 DONA'). Aks holda 0.",
                                    },
                                },
                                "required": ["name", "unit_cost"],
                            },
                        },
                        "printed_total": {
                            "type": "number",
                            "description": "Hujjatdagi jami summa, HUJJAT darajasidagi chegirmagacha (Итого / К оплате)",
                        },
                        "doc_discount_percent": {
                            "type": "number",
                            "description": "Butun hujjatga umumiy chegirma bo'lsa foizi (masalan 'Сумма скидки' / 'Итого' * 100). "
                                           "Qator ichidagi chegirma bu yerga KIRMAYDI. Yo'q bo'lsa 0.",
                        },
                    },
                    "required": ["supplier", "items"],
                },
            }
        },
        "required": ["invoices"],
    },
}

PROMPT = """Bu rasmda O'zbekistondagi do'konga kelgan tovar hujjati bor. U uch xil bo'lishi mumkin:
  1) BOSMA chek yoki nakladnoy (printerda chiqarilgan),
  2) QO'LDA to'ldirilgan "Yuk xati / Накладная" jadvali (Nomi | Soni | Narxi | Summasi),
  3) QO'LDA yozilgan erkin hisob varaqasi (masalan "banan × 19,5 = 91 000").
Bitta rasmda bir nechta hujjat bo'lsa — har birini alohida invoice qiling. Qaysi tur bo'lishidan qat'i nazar o'qing.

HAR BIR TOVAR UCHUN:
- name — tovar nomi, yozilganidek (qo'lda, qisqartirilgan bo'lsa ham o'qiyolganingizcha).
- unit_cost — bitta birlik (dona yoki kg) narxi, ya'ni "×" belgisidan keyingi / Narxi ustunidagi son.
- qty — soni (Soni/Кол-во yoki "×" dan oldingi son). O'qib bo'lmasa yoki yozilmagan bo'lsa 0.
- line_sum — qator summasi: Summasi ustuni yoki "=" dan keyingi natija. Yo'q bo'lsa 0.
- unit — dona / kg / ta / karobka / pachka. Agar qty kasr son bo'lsa (go'sht, meva: 2.602 yoki 5,9) — bu KG.

E'TIBOR BERMAYDIGAN BELGILAR (bular ma'lumot emas, tasdiq belgisi):
- ✓ galochka, "+", qator ustiga tortilgan chiziq, imzo. Bularni o'qimang.

RAQAMLARNI TO'G'RI O'QISH (juda muhim):
- "." yoki bo'sh joy odatda MING ajratgich: "81.000"=81000, "170,000"=170000, "26 000"=26000.
- Lekin SONI (qty) kichik kasr bo'lsa, "." yoki "," O'NLIK ajratgich: "2.602"=2.602 kg, "5,9"=5.9, "19,5"=19.5.
- Qoida: narx va summa — butun minglar (katta son); og'irlik — kichik kasr. Kontekstdan ayiring.
- Chegirma ustuni (Скидка / Цена со скидкой) bo'lsa: unit_cost = chegirmali narx.
  Butun hujjatga umumiy "Сумма скидки" bo'lsa — doc_discount_percent ga foiz qilib yozing.

TEKSHIRISH:
- Agar qty ham, unit_cost ham, line_sum ham bor bo'lsa: qty × unit_cost ≈ line_sum bo'lishi kerak. Mos kelmasa qayta o'qing.
- Pastdagi umumiy jami (Итого / Jami / "otilmi" / oxirgi katta son) bo'lsa — printed_total ga yozing.
- O'qib bo'lmaydigan raqamni TAXMIN QILMANG — 0 qoldiring, men ogohlantiraman.
"""


def prepare_image(raw: bytes) -> bytes:
    img = Image.open(io.BytesIO(raw))
    img = img.convert("RGB")
    img.thumbnail((2400, 2400))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=90)
    return out.getvalue()


async def extract(raw: bytes, is_pdf: bool) -> list[dict]:
    if is_pdf:
        block = {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                 "data": base64.b64encode(raw).decode()}}
    else:
        block = {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                              "data": base64.b64encode(prepare_image(raw)).decode()}}
    resp = await client.messages.create(
        model=MODEL,
        max_tokens=16000,
        tools=[EXTRACT_TOOL],
        tool_choice={"type": "tool", "name": "save_invoices"},
        messages=[{"role": "user", "content": [block, {"type": "text", "text": PROMPT}]}],
    )
    for b in resp.content:
        if b.type == "tool_use":
            return b.input.get("invoices", [])
    return []


# ---------- Narx hisoblash ----------

def sell_price(cost: float, marja: float, step: int) -> int:
    raw = cost * (1 + marja / 100)
    if step <= 0:
        return round(raw)
    return int(math.ceil(raw / step - 1e-9) * step)


def fmt(x: float) -> str:
    return f"{x:,.0f}".replace(",", " ")


def price_invoices(invoices: list[dict], marja: float, step: int) -> list[dict]:
    for inv in invoices:
        disc = float(inv.get("doc_discount_percent") or 0)
        lines_sum = 0.0
        for it in inv["items"]:
            qty = float(it.get("qty") or 0)
            cost = float(it.get("unit_cost") or 0)
            lsum = float(it.get("line_sum") or 0)
            # Yetishmayotgan qiymatni boshqalaridan chiqarish
            if cost <= 0 and lsum > 0 and qty > 0:
                cost = lsum / qty
            if qty <= 0 and lsum > 0 and cost > 0:
                qty = lsum / cost
            line_total = lsum if lsum > 0 else qty * cost
            lines_sum += line_total
            # Qator ichidagi nomuvofiqlik (qty*narx != summa)
            it["mismatch"] = bool(qty and cost and lsum) and abs(qty * cost - lsum) > max(lsum * 0.02, 500)
            it["no_cost"] = cost <= 0
            it["qty"] = qty
            real_cost = cost * (1 - disc / 100)
            it["real_cost"] = real_cost
            it["sell"] = sell_price(real_cost, marja, step) if real_cost > 0 else 0
            ppu = float(it.get("pieces_per_unit") or 0)
            it["sell_piece"] = sell_price(real_cost / ppu, marja, step) if ppu > 1 and real_cost > 0 else None
        printed = float(inv.get("printed_total") or 0)
        inv["warning"] = bool(printed) and abs(lines_sum - printed) > max(printed * 0.01, 1000)
        inv["lines_sum"] = lines_sum
    return invoices


def build_text(invoices: list[dict], marja: float, step: int) -> list[str]:
    parts = []
    for n, inv in enumerate(invoices, 1):
        head = f"📄 {n}. {inv.get('supplier', '—')}"
        if inv.get("doc_number"):
            head += f"  №{inv['doc_number']}"
        if inv.get("date"):
            head += f"  ({inv['date']})"
        lines = [head]
        disc = float(inv.get("doc_discount_percent") or 0)
        if disc:
            lines.append(f"   Umumiy chegirma {disc:.1f}% hisobga olindi")
        tot_cost = tot_sell = 0.0
        for i, it in enumerate(inv["items"], 1):
            q = float(it.get("qty") or 0)
            tot_cost += q * it["real_cost"]
            tot_sell += q * it["sell"]
            qty_str = f"{round(q, 2):g} {it.get('unit', '')} · " if q else ""
            if it.get("no_cost"):
                s = f"{i}. {it['name']}\n   {qty_str}⚠️ narx o'qilmadi, qo'lda tekshiring"
            else:
                s = (f"{i}. {it['name']}\n"
                     f"   {qty_str}kelish {fmt(it['real_cost'])} → 💰 {fmt(it['sell'])}")
                if it.get("sell_piece"):
                    s += f"  (1 donasi {fmt(it['sell_piece'])})"
                if it.get("mismatch"):
                    s += "  ⚠️ soni×narx summaga mos emas"
            lines.append(s)
        lines.append(f"Jami kelish: {fmt(tot_cost)} | sotish: {fmt(tot_sell)} | foyda: {fmt(tot_sell - tot_cost)}")
        if inv["warning"]:
            lines.append(f"⚠️ Qatorlar yig'indisi ({fmt(inv['lines_sum'])}) hujjat jamisiga "
                         f"({fmt(inv['printed_total'])}) mos emas — tekshirib chiqing")
        parts.append("\n".join(lines))
    parts.append(f"Ustama: {marja:g}% · yaxlitlash: {step} so'm")
    return parts


def build_excel(invoices: list[dict], marja: float) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Narxlar"
    hdr = ["Hujjat", "Tovar", "Miqdor", "Birlik", "Kelish narxi", f"Sotish (+{marja:g}%)",
           "1 dona sotish", "Jami kelish", "Jami sotish"]
    ws.append(hdr)
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="2E7D32")
        c.alignment = Alignment(horizontal="center", wrap_text=True)
    for inv in invoices:
        doc = f"{inv.get('supplier', '')} {inv.get('doc_number', '')}".strip()
        for it in inv["items"]:
            q = float(it.get("qty") or 0)
            ws.append([doc, it["name"], q, it.get("unit", ""), round(it["real_cost"]), it["sell"],
                       it["sell_piece"] or "", round(q * it["real_cost"]), q * it["sell"]])
    for col, w in zip("ABCDEFGHI", [28, 45, 8, 10, 14, 14, 13, 14, 14]):
        ws.column_dimensions[col].width = w
    for row in ws.iter_rows(min_row=2, min_col=5, max_col=9):
        for c in row:
            c.number_format = "# ##0"
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


# ---------- Telegram ----------

async def send_long(m: Message, parts: list[str]):
    buf = ""
    for p in parts:
        if len(buf) + len(p) + 2 > 3900:
            await m.answer(buf)
            buf = ""
        while len(p) > 3900:
            await m.answer(p[:3900])
            p = p[3900:]
        buf += p + "\n\n"
    if buf.strip():
        await m.answer(buf)


@dp.message(Command("start", "help"))
async def start(m: Message):
    if not allowed(m):
        return
    c = cfg(m.from_user.id)
    await m.answer(
        "Salom! Nakladnoy yoki chek rasmini yuboring — tovarlarni o'qib, sotish narxini chiqaraman.\n\n"
        "💡 Aniqroq o'qishi uchun rasmni 📎 Fayl qilib yuboring (siqilmaydi).\n\n"
        f"Hozirgi ustama: {c['marja']:g}%, yaxlitlash: {c['step']} so'm\n"
        "/marja 25 — ustamani o'zgartirish\n"
        "/yaxlit 500 — narxni nechaga yaxlitlash (0 = yaxlitlamaslik)"
    )


@dp.message(Command("marja"))
async def set_marja(m: Message, command: CommandObject):
    if not allowed(m):
        return
    try:
        v = float((command.args or "").replace("%", "").replace(",", "."))
        cfg(m.from_user.id)["marja"] = v
        await m.answer(f"✅ Ustama: {v:g}%")
    except ValueError:
        await m.answer("Masalan: /marja 22")


@dp.message(Command("yaxlit"))
async def set_step(m: Message, command: CommandObject):
    if not allowed(m):
        return
    try:
        v = int(command.args or "")
        cfg(m.from_user.id)["step"] = v
        await m.answer(f"✅ Yaxlitlash: {v} so'm")
    except ValueError:
        await m.answer("Masalan: /yaxlit 100")


async def process(m: Message, file_id: str, is_pdf: bool):
    c = cfg(m.from_user.id)
    wait = await m.answer("⏳ O'qiyapman...")
    try:
        f = await bot.download(file_id)
        invoices = await extract(f.read(), is_pdf)
        if not invoices or not any(inv.get("items") for inv in invoices):
            await wait.edit_text("Tovar topilmadi. Rasmni yaqinroqdan, yorug'da, fayl qilib yuboring.")
            return
        invoices = price_invoices(invoices, c["marja"], c["step"])
        await wait.delete()
        await send_long(m, build_text(invoices, c["marja"], c["step"]))
        xls = build_excel(invoices, c["marja"])
        name = f"narxlar_{datetime.now():%Y%m%d_%H%M}.xlsx"
        await m.answer_document(BufferedInputFile(xls, name))
    except Exception as e:
        logging.exception("process error")
        await wait.edit_text(f"Xatolik: {e}")


@dp.message(F.photo)
async def on_photo(m: Message):
    if allowed(m):
        await process(m, m.photo[-1].file_id, False)


@dp.message(F.document)
async def on_doc(m: Message):
    if not allowed(m):
        return
    mime = m.document.mime_type or ""
    if mime == "application/pdf":
        await process(m, m.document.file_id, True)
    elif mime.startswith("image/"):
        await process(m, m.document.file_id, False)
    else:
        await m.answer("Rasm (jpg/png) yoki PDF yuboring.")


def _start_health_server():
    """Render 'web service' ochiq port talab qiladi. Bot polling'da ishlaydi,
    shuning uchun PORT berilgan bo'lsa, oddiy 200 qaytaradigan server ishga tushiramiz."""
    port = os.getenv("PORT")
    if not port:
        return
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"bot ishlayapti")

        def log_message(self, *a):
            pass

    srv = HTTPServer(("0.0.0.0", int(port)), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    logging.info("Health-check server %s portda", port)


if __name__ == "__main__":
    import asyncio
    _start_health_server()
    asyncio.run(dp.start_polling(bot))
