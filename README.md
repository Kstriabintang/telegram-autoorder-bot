# Telegram Auto Order Bot

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4?logo=telegram&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-Postgres-3ECF8E?logo=supabase&logoColor=white)
![QRIS](https://img.shields.io/badge/Payment-QRIS-EB1C24)

Bot Telegram untuk penjualan **produk digital** secara otomatis 24/7. User memesan
lewat chat, membayar via **QRIS**, dan bot mengirimkan *activation link* secara instan
setelah pembayaran terverifikasi — tanpa campur tangan admin.

Bot berjalan dalam **mode polling** (`bot.launch()`), jadi tidak butuh URL publik atau
webhook. Cukup dijalankan di RDP / VPS / PC mana pun yang menyala terus.

## ✨ Fitur

- 🛒 **Auto order** — alur pemesanan penuh di dalam chat (pilih paket → bayar → terima).
- 💳 **Payment gateway QRIS** — generate QRIS otomatis via Pakasir, scan dari e-wallet / m-banking apa pun.
- ⚡ **Verifikasi otomatis** — bot polling status pembayaran tiap 10 detik dan langsung memenuhi order saat `completed`.
- 📦 **Manajemen stok otomatis** — stok disimpan di Supabase; klaim link bersifat **atomik** (anti dobel-jual / race condition).
- 🎟️ **Paket fleksibel** — beberapa pilihan paket dengan jumlah & harga berbeda, hanya menampilkan paket yang stoknya cukup.
- 🗂️ **Riwayat transaksi** — user dapat melihat histori pembelian yang berhasil.
- 🔔 **Notifikasi owner** — owner dapat notifikasi setiap penjualan, stok kurang, atau order macet.
- 🧹 **Auto-cleanup** — order yang tidak dibayar otomatis di-expire, order macet dilaporkan ke owner.
- 🔒 **Aman** — kredensial via `.env`, perintah simulasi terbatas khusus owner.

## 🧩 Cara Kerja

- **Telegram** — long-polling, tidak perlu webhook publik.
- **Pakasir** — bot mengecek status tiap order pending ke API Pakasir setiap 10 detik. Begitu `completed`, produk dikirim otomatis.
- **Anti dobel-jual** — klaim stok lewat fungsi Postgres atomik `claim_links` (`FOR UPDATE SKIP LOCKED`).
- **Auto-cleanup** — order belum dibayar di-expire setelah 60 menit; order `processing` macet > 10 menit dilaporkan ke owner.

## 🚀 Instalasi

### 1. Clone repository

```bash
git clone https://github.com/Kstriabintang/telegram-autoorder-bot.git
cd telegram-auto-order-bot
```

### 2. Install dependencies (butuh Node.js 18+)

```bash
npm install
```

### 3. Konfigurasi environment

Copy `.env.example` menjadi `.env`, lalu isi setiap nilainya:

```bash
cp .env.example .env
```

### 4. Setup database Supabase

Buka **SQL Editor** di dashboard Supabase, lalu jalankan skrip berikut **sekali saja**
untuk membuat tabel `stocks`, `pending_orders`, dan fungsi atomik `claim_links`:

```sql
-- Tabel stok activation link
create table if not exists stocks (
  id   bigint generated always as identity primary key,
  link text not null unique,
  used boolean not null default false
);
create index if not exists idx_stocks_unused on stocks (used) where used = false;

-- Tabel order / transaksi
create table if not exists pending_orders (
  id         bigint generated always as identity primary key,
  order_id   text not null unique,
  user_id    bigint not null,
  status     text not null default 'pending',  -- pending | processing | completed | failed | expired
  message_id bigint,
  amount     integer default 0,
  quantity   integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_orders_status on pending_orders (status);
create index if not exists idx_orders_user   on pending_orders (user_id);

-- Auto-update kolom updated_at
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_orders_updated_at on pending_orders;
create trigger trg_orders_updated_at
  before update on pending_orders
  for each row execute function set_updated_at();

-- Fungsi klaim link ATOMIK (anti dobel-jual / race condition)
create or replace function claim_links(link_count int)
returns setof stocks
language plpgsql
as $$
declare
  claimed       stocks[];
  claimed_count int;
begin
  with picked as (
    select id from stocks
    where used = false
    order by id
    for update skip locked
    limit link_count
  ),
  updated as (
    update stocks s
    set used = true
    from picked
    where s.id = picked.id
    returning s.*
  )
  select array_agg(updated), count(*) into claimed, claimed_count from updated;

  if coalesce(claimed_count, 0) <> link_count then
    raise exception 'INSUFFICIENT_STOCK: butuh %, dapat %', link_count, coalesce(claimed_count, 0);
  end if;

  return query select * from unnest(claimed);
end;
$$;
```

### 5. Isi stok

Tambahkan stok activation link ke tabel `stocks` lewat SQL Editor Supabase:

```sql
insert into stocks (link, used) values
  ('https://contoh.com/activation-link-1', false),
  ('https://contoh.com/activation-link-2', false);
```

## ⚙️ Variabel Environment

| Variable | Wajib | Keterangan |
|----------|:-----:|------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token bot dari [@BotFather](https://t.me/BotFather). |
| `OWNER_USER_ID` | ✅ | ID Telegram owner penerima notifikasi. Bisa banyak, pisahkan dengan koma. |
| `OWNER_CONTACT` | – | Username/kontak owner yang ditampilkan di menu Bantuan (mis. `@username`). |
| `SUPABASE_URL` | ✅ | Project URL dari Supabase > Project Settings > API. |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | `service_role` key (bypass RLS, untuk backend). **Rahasia.** |
| `PAKASIR_SLUG` | ✅ | Slug project dari dashboard Pakasir.com. |
| `PAKASIR_API_KEY` | ✅ | API key dari dashboard Pakasir.com. |
| `PRODUCT_NAME` | – | Nama produk yang ditampilkan ke user (default: `Digital Product`). |
| `PRODUCT_PRICE` | ✅ | Harga per item dalam Rupiah (angka saja, mis. `50000`). |
| `BANNER_URL` | – | URL gambar banner untuk pesan `/start` (opsional). |

## ▶️ Menjalankan Bot

```bash
npm start
# atau
node index.js
```

Selama proses ini menyala, bot melayani pembelian 24/7.

> 💡 **Tips produksi:** agar bot tetap jalan walau koneksi putus / setelah restart,
> gunakan [`pm2`](https://pm2.keymetrics.io/):
> ```bash
> npm install -g pm2
> pm2 start index.js --name order-bot
> pm2 save
> ```

## 🤖 Perintah Bot

| Perintah | Fungsi |
|----------|--------|
| `/start` | Menu utama + tampilan stok. |
| `/check_payment` | Cek status order pending (real-time ke Pakasir). |
| `/simulate_payment <ORDER_ID>` | Simulasi pembayaran (khusus owner, untuk testing). |
| `/help` | Info kontak owner. |

## 📁 Struktur Folder

```
.
├── index.js          # Logika utama bot (handler, polling, fulfillment, cleanup)
├── package.json      # Metadata project & dependencies
├── package-lock.json # Lockfile dependencies
├── Procfile          # Perintah start untuk platform hosting (web: npm start)
├── .env.example      # Template environment variable (copy ke .env)
├── .gitignore        # Daftar file yang tidak ikut di-commit
└── README.md         # Dokumentasi ini
```

## 🛠️ Tech Stack

- [Node.js](https://nodejs.org/) — runtime
- [Telegraf](https://telegraf.js.org/) — framework Telegram Bot
- [Supabase](https://supabase.com/) (Postgres) — database stok & transaksi
- [Pakasir](https://pakasir.com/) — payment gateway QRIS
- [axios](https://axios-http.com/) — HTTP client
