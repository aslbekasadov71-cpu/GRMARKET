# Nakladnoy narx boti

Nakladnoy yoki chek rasmini yuborasiz → bot har bir tovarni o'qiydi → kelish narxiga 22% qo'shib sotish narxini chiqaradi + Excel fayl beradi.

Uch xil hujjatni o'qiydi:
- Bosma kassa chek / nakladnoy
- Qo'lda to'ldirilgan "Yuk xati / Накладная" jadvali
- Qo'lda yozilgan erkin hisob varaqasi (masalan `banan × 19,5 = 91 000`)

Yana:
- Bitta rasmda bir nechta hujjat bo'lsa, hammasini alohida ajratadi
- ✓ galochka, "+", chiziq kabi tasdiq belgilarini o'qimaydi
- Go'sht/meva kg da (2.602 kg, 5,9 kg) bo'lsa to'g'ri tushunadi
- "Цена со скидкой", qator chegirmasi va umumiy "Сумма скидки" hisobga olinadi
- Faqat summa yozilgan bo'lsa (`= 136 000`), narxni sonidan chiqaradi
- Narx o'qilmasa yoki soni×narx summaga mos kelmasa ⚠️ ogohlantiradi
- Narx yuqoriga yaxlitlanadi (standart 100 so'm)

## O'rnatish

1. Telegramda **@BotFather** → `/newbot` → token oling
2. **console.anthropic.com** da ro'yxatdan o'ting, API kalit oling, balans to'ldiring
3. Kompyuter yoki serverda:

```bash
pip install -r requirements.txt
cp .env.example .env      # ichiga token va kalitni yozing
python bot.py
```

Kompyuter o'chsa bot ham to'xtaydi. Doimiy ishlashi uchun arzon serverga (VPS, Render va h.k.) qo'ying.

## Buyruqlar

- `/marja 25` — ustamani o'zgartirish
- `/yaxlit 500` — narxni 500 ga yaxlitlash
- `/start` — yordam

## Maslahat

Rasmni **📎 Fayl** sifatida yuboring — Telegram siqmaydi, raqamlar aniqroq o'qiladi. Bir rasmga 1–2 ta nakladnoy qo'ysangiz xato kamroq bo'ladi.

## Ustama haqida

`MARJA=22` → sotish = kelish × 1.22 (8 350 → 10 200).
Agar "sotish narxining 22% i foyda bo'lsin" desangiz, bu boshqacha: kelish ÷ 0.78 ≈ 28.2% ustama. Unda `MARJA=28.2` qo'ying.
