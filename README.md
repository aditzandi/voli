# TukarView (versi gratis): Telegram Mini App

Tukar tonton video: 1 detik tonton = 1 poin. Poin dipakai untuk boost video sendiri (durasi x jumlah penonton).

## Aturan sistem
- Login lewat Telegram. Data login diverifikasi di server dengan HMAC resmi Telegram.
- 1 akun Telegram = 1 user. Pendaftaran dibatasi `IP_LIMIT` akun per IP (default 1).
- Pemilik video tidak bisa menonton videonya sendiri (dicek di server saat start dan finish).
- Satu video hanya bisa dihitung sekali per member.
- Durasi divalidasi server: waktu tonton dihitung dari selisih jam server lewat heartbeat, bukan angka dari klien.
- Poin dihitung 1:1. Penonton dapat `detik` poin, pemilik video membayar `detik x jumlah view` di awal. Boost bisa dibatalkan dan sisanya dikembalikan.
- Panel admin untuk daftar member: cari, blokir/aktifkan, tambah/kurangi poin.

## Struktur
- `public/index.html`: tampilan Mini App
- `src/worker.js`: API (Cloudflare Worker)
- `schema.sql`: tabel database (Cloudflare D1)
- `wrangler.toml`: konfigurasi

## Langkah pasang (semua gratis)
1. Buat bot di Telegram: chat @BotFather, kirim `/newbot`, simpan token dan username bot.
2. Daftar akun gratis di cloudflare.com, lalu di komputer (butuh Node.js):
   ```
   npm install -g wrangler
   wrangler login
   ```
3. Buat database:
   ```
   wrangler d1 create tukarview
   ```
   Salin `database_id` yang muncul ke `wrangler.toml`.
4. Isi tabel:
   ```
   wrangler d1 execute tukarview --remote --file=schema.sql
   ```
5. Edit `wrangler.toml`: isi `BOT_USERNAME` (tanpa @) dan `ADMIN_IDS` (ID Telegram Anda, cek lewat @userinfobot).
6. Simpan rahasia:
   ```
   wrangler secret put BOT_TOKEN
   wrangler secret put IP_SALT
   ```
   `IP_SALT` bebas, isi teks acak panjang.
7. Deploy:
   ```
   wrangler deploy
   ```
   Anda akan mendapat alamat `https://tukarview.NAMAANDA.workers.dev`.
8. Hubungkan ke bot: di @BotFather kirim `/newapp`, pilih bot, dan isi URL dari langkah 7. Atau `/mybots`, pilih bot, Bot Settings, Menu Button, isi URL yang sama.
9. Buka bot di Telegram dan jalankan Mini App.

## Upload ke GitHub
Upload seluruh folder ini ke repository GitHub. Jangan masukkan token bot ke file mana pun. Untuk deploy otomatis, di dashboard Cloudflare buka Workers & Pages, pilih Create, lalu Connect to Git dan pilih repository ini.

## Batas gratis Cloudflare (perkiraan)
Worker 100 ribu request per hari dan D1 100 ribu baris tulis per hari. Satu tontonan 30 detik memakai sekitar 8 request. Cukup untuk beberapa ribu tontonan per hari. Kalau member sudah banyak, upgrade paket Workers (sekitar 5 USD per bulan).

## Catatan penting
- **Aturan 1 IP:** di Indonesia banyak pengguna seluler berbagi IP yang sama (CGNAT). Dengan `IP_LIMIT=1`, sebagian member asli bisa ditolak mendaftar. Jika itu terjadi, naikkan ke 2 atau 3.
- **Bot dan akun palsu:** pembatasan IP dan Telegram tidak menjamin 100% anti-curang. Pantau daftar member di panel admin dan blokir yang mencurigakan.
- **`DEV_MODE`:** jangan diaktifkan di produksi (default mati).
- **Kebijakan YouTube:** tukar view tetap bisa melanggar ketentuan YouTube. Gunakan dengan risiko sendiri.
