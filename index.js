require('dotenv').config();
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Nama produk & kontak owner — diisi lewat .env agar bot generic / bisa dipakai ulang.
const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Digital Product';
const OWNER_CONTACT = process.env.OWNER_CONTACT || '';
// Banner produk (opsional) — Telegram ambil langsung dari URL, tanpa upload.
const BANNER_URL = process.env.BANNER_URL || '';
// Cache file_id Telegram: ambil sekali, lalu reuse (lebih cepat di /start berikutnya).
let bannerFileId = null;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
// Pakai service_role key (bypass RLS, untuk backend). Fallback ke anon key.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const PAKASIR_BASE = 'https://app.pakasir.com/api';

// Polling intervals (ms)
const PAYMENT_POLL_INTERVAL = 10_000;   // cek status pembayaran tiap 10 detik
const CLEANUP_INTERVAL = 5 * 60_000;    // bersihkan order basi tiap 5 menit

// Expiry windows (ms)
const TEMP_ORDER_TTL = 30 * 60_000;     // temp order (belum lanjut bayar) basi setelah 30 menit
const REAL_ORDER_TTL = 60 * 60_000;     // order QRIS belum dibayar expired setelah 60 menit

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------
// Daftar owner (bisa lebih dari 1, dipisah koma di OWNER_USER_ID).
const OWNER_IDS = (process.env.OWNER_USER_ID || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

/** Kirim notifikasi ke semua owner (format Markdown). Best-effort. */
async function notifyOwner(text) {
  for (const id of OWNER_IDS) {
    try {
      await bot.telegram.sendMessage(id, text, { parse_mode: 'Markdown' });
    } catch (e) {
      console.log(`notifyOwner gagal untuk ${id}:`, e.message);
    }
  }
}

async function getStockCount() {
  const { count } = await supabase
    .from('stocks')
    .select('*', { count: 'exact', head: true })
    .eq('used', false);
  return count || 0;
}

/**
 * Klaim N link secara ATOMIK lewat RPC Postgres `claim_links`.
 * Fungsi DB akan menandai link used=true dalam satu transaksi terkunci
 * (FOR UPDATE SKIP LOCKED), atau gagal total kalau stok kurang.
 * Mengembalikan array string link, atau null jika gagal/stok kurang.
 */
async function claimLinks(count) {
  const { data, error } = await supabase.rpc('claim_links', { link_count: count });
  if (error) {
    // Bedakan: stok benar-benar kurang (INSUFFICIENT_STOCK) vs error transien (DB/koneksi).
    const insufficient = /INSUFFICIENT_STOCK/i.test(error.message || '');
    console.error(`claim_links gagal (${count} link), insufficient=${insufficient}:`, error.message);
    return { ok: false, insufficient, links: [] };
  }
  return { ok: true, insufficient: false, links: (data || []).map(row => row.link) };
}

/** Escape karakter Markdown agar konten dinamis (nama user) tidak merusak format. */
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/[*_`\[\]]/g, '');
}

async function addPendingOrder(orderId, userId, messageId = null, amount = null, quantity = 1) {
  const { data, error } = await supabase
    .from('pending_orders')
    .insert({ order_id: orderId, user_id: userId, status: 'pending', message_id: messageId, amount, quantity })
    .select();

  if (error) {
    console.error(`FAILED TO SAVE PENDING ORDER ${orderId}:`, error);
    throw new Error(`Database insert failed: ${error.message}`);
  }
  return data;
}

// Paket tetap: jumlah link + harga QRIS-nya (fixed, bukan kelipatan lurus).
const PACKAGES = [
  { id: 0, qty: 1,  price: 150000 },
  { id: 1, qty: 5,  price: 600000 },
  { id: 2, qty: 10, price: 1100000 }
];

/** Render pesan + keyboard pilih paket. Hanya tampilkan paket yang stoknya cukup. */
function buildPackageView(stock) {
  const text = `🛍️ *PILIH PAKET*
━━━━━━━━━━━━━━━━━━━
📦 ${PRODUCT_NAME}
📊 Stok tersedia: *${stock}*

Pilih paket pembelian di bawah ⬇️

📢 _Dengan membeli, kamu dianggap sudah membaca & memahami ketentuan produk, termasuk cara penggunaan & aktivasinya._`;

  const inline_keyboard = PACKAGES
    .filter(p => p.qty <= stock)
    .map(p => [{
      text: `🎟️ ${p.qty} Link — Rp ${p.price.toLocaleString()}`,
      callback_data: `buypkg:${p.id}`
    }]);
  inline_keyboard.push([{ text: '❌ Batal', callback_data: 'cancel_pkg' }]);

  return { text, reply_markup: { inline_keyboard } };
}

/** Buat transaksi QRIS Pakasir + kirim QR + simpan order. Dipakai oleh pilih paket. */
async function createQrisOrder(ctx, userId, quantity, totalAmount) {
  const orderId = Math.random().toString(36).substring(2, 10).toUpperCase();
  try {
    const response = await axios.post(
      `${PAKASIR_BASE}/transactioncreate/qris`,
      {
        project: process.env.PAKASIR_SLUG,
        order_id: orderId,
        amount: totalAmount,
        api_key: process.env.PAKASIR_API_KEY
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (!response.data.payment || !response.data.payment.payment_number) {
      throw new Error('Invalid QR response from Pakasir');
    }

    const qrString = response.data.payment.payment_number;
    // Render QR lewat URL (Telegram yang ambil gambarnya, tanpa upload file).
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&margin=16&data=${encodeURIComponent(qrString)}`;

    await ctx.editMessageText('🔄 Memproses pembayaran...');
    const qrMessage = await ctx.replyWithPhoto(
      qrUrl,
      {
        caption: `💳 Pembayaran QRIS\n\n💰 Jumlah: Rp ${totalAmount.toLocaleString()}\n🆔 Order ID: ${orderId}\n🔢 Jumlah link: ${quantity}\n\n📱 Scan QR code di atas menggunakan aplikasi e-wallet Anda.\n\n⚡ Pembayaran akan diverifikasi otomatis dalam 1-3 menit.${totalAmount <= 1000 ? '\n\n🧪 TEST: Untuk simulasi tanpa bayar, gunakan /simulate_payment ' + orderId : ''}`
      }
    );

    await addPendingOrder(orderId, userId, qrMessage.message_id, totalAmount, quantity);
    console.log(`>> Order saved: ${orderId} user ${userId}, qty ${quantity}, amount ${totalAmount}`);
  } catch (error) {
    if (error.response) {
      console.error('>> Pakasir error:', error.response.status, JSON.stringify(error.response.data));
    } else {
      console.error('>> Pakasir error:', error.message);
    }
    await ctx.editMessageText('❌ Gagal membuat transaksi. Silakan coba lagi.');
  }
}

const mainKeyboard = {
  keyboard: [
    ['🛍️ Beli Sekarang', '📦 Cek Stok'],
    ['📲 Cara Aktivasi', '🧾 Cara Pembelian'],
    ['💳 Cek Pembayaran', '🗂️ Riwayat Saya'],
    ['❔ FAQ', '💬 Bantuan']
  ],
  resize_keyboard: true
};

const HELP_MSG = `❓ *BANTUAN & SUPPORT*
━━━━━━━━━━━━━━━━━━━
Ada pertanyaan, kendala transaksi,
atau butuh bantuan? 💬
Owner kami siap membantu kamu.

👤 *Kontak Owner*
👉 ${OWNER_CONTACT || '(hubungi admin)'}

🕒 _Fast response • Ramah • Terpercaya_
🙏 Terima kasih sudah mempercayai kami!`;

// ---------------------------------------------------------------------------
// Bot commands
// ---------------------------------------------------------------------------
bot.help(async (ctx) => {
  ctx.reply(HELP_MSG, { parse_mode: 'Markdown' });
});

// Cek status pembayaran pending (dipakai oleh /check_payment & tombol 💳 Cek Pembayaran)
async function sendPaymentStatus(ctx) {
  const userId = ctx.from.id;

  const { data: pendingOrders } = await supabase
    .from('pending_orders')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .gt('amount', 0)
    .order('created_at', { ascending: false })
    .limit(3);

  if (!pendingOrders || pendingOrders.length === 0) {
    return ctx.reply(`💳 *STATUS PEMBAYARAN*
━━━━━━━━━━━━━━━━━━━
✅ Tidak ada pembayaran pending.
Semua transaksimu sudah beres! 🎉

🛍️ Mau order lagi? Ketuk *Beli Sekarang*`, { parse_mode: 'Markdown' });
  }

  let message = '💳 *Status Pembayaran Anda*\n\n';
  for (const order of pendingOrders) {
    const createdDate = new Date(order.created_at).toLocaleString('id-ID');
    message += `🆔 Order ID: \`${order.order_id}\`\n`;
    message += `📅 Dibuat: ${createdDate}\n`;
    message += `📊 Status: ⏳ Pending\n\n`;

    try {
      const response = await axios.get(
        `${PAKASIR_BASE}/transactiondetail?project=${process.env.PAKASIR_SLUG}&order_id=${order.order_id}&amount=${order.amount}&api_key=${process.env.PAKASIR_API_KEY}`
      );
      if (response.data.transaction) {
        const status = response.data.transaction.status;
        if (status === 'completed') {
          message += `✅ Status terbaru dari Pakasir: Berhasil\n`;
          message += `💡 Link akan dikirim otomatis dalam beberapa detik.\n\n`;
        } else {
          message += `⏳ Status terbaru dari Pakasir: ${status}\n\n`;
        }
      }
    } catch (error) {
      console.log(`Failed to check Pakasir status for ${order.order_id}`);
      message += `❓ Tidak dapat cek status real-time\n\n`;
    }
  }

  message += `💡 Gunakan ❔ FAQ atau 💬 Bantuan jika ada kendala.`;
  ctx.reply(message, { parse_mode: 'Markdown' });
}

bot.command('check_payment', (ctx) => sendPaymentStatus(ctx));

bot.command('simulate_payment', async (ctx) => {
  // KEAMANAN: hanya owner yang boleh simulasi pembayaran (cegah link gratis).
  if (!OWNER_IDS.includes(String(ctx.from.id))) {
    return ctx.reply('❌ Perintah ini khusus admin.');
  }

  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply('❌ Format: /simulate_payment <ORDER_ID>');
  }

  const orderId = args[1].toUpperCase();

  const { data: order } = await supabase
    .from('pending_orders')
    .select('amount, quantity')
    .eq('order_id', orderId)
    .single();

  if (!order) {
    return ctx.reply('❌ Order ID tidak ditemukan.');
  }

  try {
    const response = await axios.post(
      `${PAKASIR_BASE}/paymentsimulation`,
      {
        project: process.env.PAKASIR_SLUG,
        order_id: orderId,
        amount: order.amount,
        api_key: process.env.PAKASIR_API_KEY
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (response.data.success) {
      ctx.reply(`✅ *Simulasi Pembayaran Berhasil*\n\n🆔 Order ID: ${orderId}\n💰 Jumlah: Rp ${order.amount.toLocaleString()}\n🔢 Quantity: ${order.quantity}\n\nLink aktivasi akan dikirim otomatis dalam beberapa detik.`, { parse_mode: 'Markdown' });
    } else {
      ctx.reply('❌ Simulasi gagal. Pastikan Order ID benar.');
    }
  } catch (error) {
    console.error('Simulation error:', error.message);
    ctx.reply('❌ Error saat simulasi. Coba lagi.');
  }
});

bot.start(async (ctx) => {
  console.log('/start received from user:', ctx.from?.id);
  const stock = await getStockCount();
  const price = parseInt(process.env.PRODUCT_PRICE);

  const caption = `🛍️ *${PRODUCT_NAME.toUpperCase()}*
━━━━━━━━━━━━━━━━━━━
📊 Stok tersedia : *${stock}*
💰 Harga : *Rp ${price.toLocaleString()}* / item

🔥 *KEUNGGULAN*
✅ Proses otomatis tanpa nunggu admin
✅ Pembayaran QRIS — otomatis 24/7
✅ Produk dikirim instan via chat

🛒 *CARA ORDER*
Tekan tombol *🛍️ Beli Sekarang* di bawah ⬇️
━━━━━━━━━━━━━━━━━━━
⚡ _Cepat • Aman • Terpercaya_`;

  try {
    // Pakai file_id kalau sudah pernah diambil; kalau belum, pakai URL CDN.
    const photo = bannerFileId || BANNER_URL;
    const sent = await ctx.replyWithPhoto(photo, {
      caption, parse_mode: 'Markdown', reply_markup: mainKeyboard
    });
    // Simpan file_id dari upload pertama -> /start berikutnya instan.
    if (!bannerFileId && sent.photo && sent.photo.length) {
      bannerFileId = sent.photo[sent.photo.length - 1].file_id;
      console.log('Banner file_id di-cache:', bannerFileId);
    }
  } catch (error) {
    console.log('Banner gagal, kirim teks saja...', error.message);
    ctx.reply(caption, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  if (text === '🛍️ Beli Sekarang') {
    const stock = await getStockCount();
    if (stock === 0) {
      return ctx.reply('❌ Maaf, stok habis saat ini.');
    }

    const { text: msg, reply_markup } = buildPackageView(stock);
    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup });

  } else if (text === '📦 Cek Stok') {
    const stock = await getStockCount();
    const status = stock === 0
      ? '🔴 *Habis* — pantau terus ya!'
      : stock <= 9
        ? '🟡 *Menipis* — buruan order!'
        : '🟢 *Ready* — siap order!';
    ctx.reply(`📦 *CEK STOK*
━━━━━━━━━━━━━━━━━━━
🛰️ Produk: *${PRODUCT_NAME}*

📊 Stok tersedia: *${stock} item*
${status}

🛍️ Ketuk *Beli Sekarang* untuk order ⬇️`, { parse_mode: 'Markdown' });

  } else if (text === '🧾 Cara Pembelian') {
    ctx.reply(`🧾 *CARA PEMBELIAN*
━━━━━━━━━━━━━━━━━━━
1️⃣ Klik *🛍️ Beli Sekarang*
2️⃣ Pilih paket (1 / 5 / 10 link)
3️⃣ Scan QRIS yang muncul
4️⃣ Lakukan pembayaran
5️⃣ Link otomatis dikirim langsung di chat

⚠️ *PENTING*
• Koneksi stabil saat pembayaran
• Link dikirim setelah bayar terverifikasi
• Cek status lewat *💳 Cek Pembayaran*

💬 Ada kendala? Klik *💬 Bantuan*`, { parse_mode: 'Markdown' });

  } else if (text === '📲 Cara Aktivasi') {
    ctx.reply(`📲 *CARA AKTIVASI*
━━━━━━━━━━━━━━━━━━━
Setelah pembayaran sukses, activation link langsung dikirim di chat. Cara pakai:

1️⃣ Ketuk activation link (otomatis tersalin)
2️⃣ Buka link di browser
3️⃣ Redeem kode aktivasi (otomatis muncul)
4️⃣ Ikuti instruksi sesuai produk
5️⃣ Lanjutkan sampai aktivasi selesai

📌 *TIPS*
• 1 link = 1 aktivasi
• Simpan link baik-baik

💬 Bingung? Klik *💬 Bantuan*`, { parse_mode: 'Markdown' });

  } else if (text === '💳 Cek Pembayaran') {
    await sendPaymentStatus(ctx);

  } else if (text === '❔ FAQ') {
    ctx.reply(`❔ *FAQ — PERTANYAAN UMUM*
━━━━━━━━━━━━━━━━━━━
❓ *Berapa lama link dikirim?*
Otomatis & instan — biasanya dalam hitungan detik setelah pembayaran terverifikasi.

❓ *Pakai metode bayar apa?*
QRIS — bisa semua e-wallet & m-banking.

❓ *Link belum masuk setelah bayar?*
Klik *💳 Cek Pembayaran*. Bila sudah "Berhasil" tapi link belum datang, tunggu beberapa menit atau hubungi *💬 Bantuan*.

❓ *1 link untuk berapa aktivasi?*
1 link = 1 aktivasi.

━━━━━━━━━━━━━━━━━━━
📢 *PEMBERITAHUAN*
Dengan melakukan pembelian, kamu dianggap *sudah membaca & memahami* seluruh informasi produk di atas, *termasuk cara penggunaan & aktivasinya*.`, { parse_mode: 'Markdown' });

  } else if (text === '💬 Bantuan') {
    ctx.reply(HELP_MSG, { parse_mode: 'Markdown' });

  } else if (text === '🗂️ Riwayat Saya') {
    const { data: completedOrders } = await supabase
      .from('pending_orders')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('updated_at', { ascending: false })
      .limit(5);

    if (!completedOrders || completedOrders.length === 0) {
      return ctx.reply(`🗂️ *RIWAYAT PEMBELIAN*
━━━━━━━━━━━━━━━━━━━
📭 Belum ada pembelian yang berhasil.

🛍️ Yuk mulai order pertamamu —
ketuk *Beli Sekarang*!`, { parse_mode: 'Markdown' });
    }

    let message = '📜 *Riwayat Pembelian Anda*\n\n';
    completedOrders.forEach((order, index) => {
      const completedDate = new Date(order.updated_at || order.created_at).toLocaleString('id-ID');
      message += `${index + 1}. 🆔 Order ID: ${order.order_id}\n`;
      message += `   📦 Produk: ${PRODUCT_NAME}\n`;
      message += `   🔢 Jumlah: ${order.quantity || 1} link\n`;
      message += `   💰 Total: Rp ${(order.amount || 0).toLocaleString()}\n`;
      message += `   📅 Tanggal: ${completedDate}\n`;
      message += `   📊 Status: ✅ Sukses\n\n`;
    });

    message += `💡 Total transaksi berhasil: ${completedOrders.length}`;
    ctx.reply(message, { parse_mode: 'Markdown' });

  } else {
    ctx.reply('⚠️ Silakan pilih opsi dari menu di bawah.');
  }
});

// ---------------------------------------------------------------------------
// Inline keyboard callbacks
// ---------------------------------------------------------------------------
// User memilih sebuah paket -> langsung buat QRIS sesuai harga & jumlah paket itu.
bot.action(/buypkg:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const pkg = PACKAGES[parseInt(ctx.match[1])];
  if (!pkg) {
    return ctx.editMessageText('❌ Paket tidak valid. Silakan ulangi.');
  }

  const userId = ctx.from.id;
  const stock = await getStockCount();
  if (pkg.qty > stock) {
    return ctx.editMessageText(`❌ Stok tidak mencukupi untuk paket ${pkg.qty} link.\nSisa stok: ${stock}.`);
  }

  // Harga & jumlah link MURNI dari paket -> QRIS pasti sesuai, link pasti sesuai.
  await createQrisOrder(ctx, userId, pkg.qty, pkg.price);
});

bot.action('cancel_pkg', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.editMessageText('❌ Pembelian dibatalkan.');
});

// ---------------------------------------------------------------------------
// Payment fulfillment (dipanggil oleh polling Pakasir)
// ---------------------------------------------------------------------------
async function fulfillOrder(order) {
  const { order_id, user_id, message_id, quantity = 1, amount = 0 } = order;

  // 1) Klaim order secara atomik: pending -> processing.
  //    Kalau baris tidak terupdate, berarti poll cycle lain sudah memproses.
  const { data: claimed } = await supabase
    .from('pending_orders')
    .update({ status: 'processing' })
    .eq('order_id', order_id)
    .eq('status', 'pending')
    .select();

  if (!claimed || claimed.length === 0) {
    return; // sudah / sedang diproses
  }

  console.log(`Fulfilling order ${order_id} (qty ${quantity}) for user ${user_id}`);

  // 2) Klaim link secara atomik lewat RPC (anti dobel-jual).
  const result = await claimLinks(quantity);

  if (!result.ok) {
    if (result.insufficient) {
      // Stok benar-benar kurang -> tandai gagal + beri tahu user & owner (perlu refund).
      await supabase.from('pending_orders').update({ status: 'failed' }).eq('order_id', order_id);
      console.log(`ERROR: Stok kurang untuk ${order_id}, butuh ${quantity}`);
      try {
        await bot.telegram.sendMessage(user_id, '❌ Maaf, stok tidak mencukupi. Dana akan direfund 1-3 hari kerja. Hubungi admin untuk info refund.');
      } catch (e) { /* abaikan */ }
      await notifyOwner(`⚠️ STOK KURANG\n\nOrder: ${order_id}\nUser: ${user_id}\nButuh: ${quantity} link\n\nUser sudah bayar tapi stok tidak cukup — perlu refund / isi stok.`);
    } else {
      // Error transien (DB/koneksi) -> kembalikan ke 'pending' agar dicoba ulang poll berikutnya.
      // (Fungsi DB sudah rollback, jadi tidak ada link yang terklaim.)
      await supabase.from('pending_orders').update({ status: 'pending' }).eq('order_id', order_id);
      console.error(`Transient error klaim link ${order_id} -> dikembalikan ke pending untuk retry`);
    }
    return;
  }

  const links = result.links;

  // 3) Tandai order selesai.
  await supabase
    .from('pending_orders')
    .update({ status: 'completed' })
    .eq('order_id', order_id);

  // 4) Hapus pesan QR (best-effort).
  if (message_id) {
    try {
      await bot.telegram.deleteMessage(user_id, message_id);
    } catch (e) {
      console.log(`Gagal hapus pesan QR: ${e.message}`);
    }
  }

  // 5) Kirim link langsung di chat (text rapi, tiap link tap-to-copy).
  const linksText = links.join('\n');
  const linkList = links.map((l, i) => `${i + 1}. \`${l}\``).join('\n');
  const deliveryMsg = `✅ *PEMBAYARAN BERHASIL!*
━━━━━━━━━━━━━━━━━━━
Terima kasih atas pembelianmu 🙏

🔑 *${quantity} Activation Link ${PRODUCT_NAME}:*
${linkList}

📌 _Ketuk link untuk menyalin._
🔒 Setiap link untuk 1 aktivasi.
📲 Cara pakai: menu *Cara Aktivasi*`;
  try {
    await bot.telegram.sendMessage(user_id, deliveryMsg, { parse_mode: 'Markdown' });
    console.log(`SUCCESS: ${quantity} link terkirim ke user ${user_id} (order ${order_id})`);

    // Notifikasi penjualan ke owner.
    let buyer = `ID ${user_id}`;
    try {
      const chat = await bot.telegram.getChat(user_id);
      const nama = mdEscape([chat.first_name, chat.last_name].filter(Boolean).join(' '));
      const uname = chat.username ? ' (@' + mdEscape(chat.username) + ')' : '';
      buyer = `${nama || 'Tanpa nama'}${uname}\nID: ${user_id}`;
    } catch (e) { /* abaikan, pakai ID saja */ }
    const sisaStok = await getStockCount();
    await notifyOwner(`🎉 *PENJUALAN BARU!*
━━━━━━━━━━━━━━━━━━━
👤 Pembeli: ${buyer}
🔢 Jumlah: ${quantity} link
💰 Total: Rp ${Number(amount).toLocaleString()}
🆔 Order: ${order_id}
📦 Sisa stok: ${sisaStok} link
🕒 ${new Date().toLocaleString('id-ID')}`);
  } catch (e) {
    console.error(`Gagal kirim link untuk ${order_id}:`, e.message);
    // Link sudah terklaim & order completed; owner bisa kirim manual.
    await notifyOwner(`⚠️ GAGAL KIRIM LINK\n\nOrder: ${order_id}\nUser: ${user_id}\nQty: ${quantity}\n\nLink (kirim manual ke user):\n${linksText}`);
  }
}

// ---------------------------------------------------------------------------
// Pakasir payment polling
// ---------------------------------------------------------------------------
let polling = false;

async function pollPayments() {
  if (polling) return; // hindari overlap antar tick
  polling = true;
  try {
    const { data: orders } = await supabase
      .from('pending_orders')
      .select('*')
      .eq('status', 'pending')
      .gt('amount', 0); // temp order amount=0 -> diabaikan

    for (const order of orders || []) {
      try {
        const res = await axios.get(
          `${PAKASIR_BASE}/transactiondetail?project=${process.env.PAKASIR_SLUG}&order_id=${order.order_id}&amount=${order.amount}&api_key=${process.env.PAKASIR_API_KEY}`
        );
        const tx = res.data.transaction;
        if (!tx || tx.status !== 'completed') continue;

        // Verifikasi jumlah bayar cocok dengan order.
        if (Number(tx.amount) !== Number(order.amount)) {
          console.warn(`Amount mismatch ${order.order_id}: dibayar ${tx.amount}, seharusnya ${order.amount}`);
          continue;
        }

        await fulfillOrder(order);
      } catch (e) {
        console.log(`Poll gagal untuk ${order.order_id}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('pollPayments error:', e.message);
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------------------
// Cleanup order basi / kedaluwarsa
// ---------------------------------------------------------------------------
async function cleanupStaleOrders() {
  try {
    // 1) Hapus temp order lama (amount=0) — pengaman, walau flow paket tak buat temp.
    const tempCutoff = new Date(Date.now() - TEMP_ORDER_TTL).toISOString();
    await supabase
      .from('pending_orders')
      .delete()
      .eq('amount', 0)
      .lt('created_at', tempCutoff);

    // 2) Order QRIS belum dibayar > 60 menit -> expired + beri tahu user (penanganan timeout).
    const realCutoff = new Date(Date.now() - REAL_ORDER_TTL).toISOString();
    const { data: expiring } = await supabase
      .from('pending_orders')
      .select('order_id, user_id, message_id')
      .eq('status', 'pending')
      .gt('amount', 0)
      .lt('created_at', realCutoff);

    for (const o of expiring || []) {
      await supabase.from('pending_orders').update({ status: 'expired' }).eq('order_id', o.order_id);
      if (o.message_id) {
        try { await bot.telegram.deleteMessage(o.user_id, o.message_id); } catch (e) { /* abaikan */ }
      }
      try {
        await bot.telegram.sendMessage(o.user_id, `⌛ Order \`${o.order_id}\` kedaluwarsa karena belum dibayar dalam 1 jam.\n\n🛍️ Silakan order ulang lewat *Beli Sekarang*.`, { parse_mode: 'Markdown' });
      } catch (e) { /* abaikan */ }
    }

    // 3) Order 'processing' macet > 10 menit (fulfillment terputus, mis. proses mati) -> alert owner.
    const stuckCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data: stuck } = await supabase
      .from('pending_orders')
      .select('order_id, user_id, quantity')
      .eq('status', 'processing')
      .lt('updated_at', stuckCutoff);

    for (const o of stuck || []) {
      await supabase.from('pending_orders').update({ status: 'failed' }).eq('order_id', o.order_id);
      await notifyOwner(`⚠️ ORDER MACET (processing)\n\nOrder: ${o.order_id}\nUser: ${o.user_id}\nQty: ${o.quantity}\n\nFulfillment terputus. Cek manual: apakah link sudah terkirim & stok sudah terpotong.`);
    }
  } catch (e) {
    console.error('cleanupStaleOrders error:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function startBot() {
  // Pastikan tidak ada webhook tersisa, lalu jalankan long-polling Telegram.
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
  } catch (e) {
    console.log('deleteWebhook:', e.message);
  }

  // Jadwalkan polling pembayaran + cleanup DULU.
  // PENTING: bot.launch() di Telegraf v4 baru resolve saat bot berhenti,
  // jadi semua ini harus diset SEBELUM launch (atau launch tidak di-await).
  setInterval(pollPayments, PAYMENT_POLL_INTERVAL);
  setInterval(cleanupStaleOrders, CLEANUP_INTERVAL);
  cleanupStaleOrders(); // jalankan sekali saat start
  console.log(`💳 Polling pembayaran Pakasir tiap ${PAYMENT_POLL_INTERVAL / 1000}s.`);

  // Jalankan long-polling Telegram — JANGAN di-await (promise-nya tidak resolve sampai bot stop).
  bot.launch();
  console.log('🤖 Bot Telegram berjalan (polling mode) — siap di RDP.');
}

// Global error handler — cegah bot "diam" saat ada error tak terduga di handler.
bot.catch((err, ctx) => {
  console.error('Unhandled bot error:', err);
  try {
    ctx.reply('⚠️ Terjadi kesalahan sistem. Coba lagi sebentar lagi, atau hubungi 💬 Bantuan jika berlanjut.');
  } catch (e) { /* abaikan */ }
});

process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

startBot().catch((err) => {
  console.error('Gagal start bot:', err);
  process.exit(1);
});
