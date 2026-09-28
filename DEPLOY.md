# Deploy gratis (uji coba)

## Website
Untuk tahap pertama, gunakan project ini sebagai satu service Node/Render karena FFmpeg + Baileys tidak dapat dijalankan langsung sebagai proses permanen di Vercel/Netlify.

1. Push folder ini ke GitHub.
2. Render → New Web Service → pilih repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Runtime: Node.
6. Tambahkan env `CLAIM_TTL_MINUTES=30`.
7. Tambahkan Docker/FFmpeg support melalui Dockerfile jika Render meminta runtime container.

## Domain
Setelah service aktif, pasang custom domain `relzzvoldygod.my.id` di platform yang dipakai. DNS mengikuti record yang diberikan platform.

## WhatsApp
Buka website → upload video → tekan Aktifkan Bot. Untuk pairing pertama, worker perlu menampilkan QR di log. Scan QR dengan WhatsApp. Session tersimpan di `data/auth` pada filesystem; pada free/ephemeral hosting session dapat hilang saat redeploy/restart, sehingga ini hanya MVP.

## Catatan
Jangan masukkan kredensial WhatsApp atau token rahasia ke GitHub.
