# Rumi Talk — Alur & Fitur Aplikasi

Dokumen ini menjelaskan **apa itu Rumi Talk**, **bagaimana user memakainya**, dan **halaman apa saja yang ada**. Tidak membahas teknis implementasi sama sekali.

---

## 1. Apa itu Rumi Talk

Rumi Talk adalah ruang refleksi digital. User datang membawa **keresahan** — pertanyaan hidup, kegelisahan, atau curahan hati — dan Rumi merespons dengan **kutipan puisinya** yang relevan, lengkap dengan **audio bersuara Rumi** dan **penjelasan mendalam** yang seolah Rumi sendiri yang berbicara.

Bukan chatbot biasa. Bukan tempat tanya jawab faktual. Ini ruang kontemplasi — sederhana, puitis, premium.

### Karakter produk
- **Reflektif, bukan transaksional** — user tidak mencari jawaban cepat, tapi ruang merenung
- **Stateless per pertukaran** — Rumi tidak mengingat apa yang user katakan sebelumnya. Tiap keresahan berdiri sendiri, ditemui dengan kutipan yang segar
- **Anonim** — tidak ada akun, tidak ada login. User langsung bisa mulai
- **Multi-bahasa input** — Indonesia atau Inggris, keduanya didukung

---

## 2. Konsep inti

### Keresahan
Apa pun yang user tulis di kolom input. Bisa kalimat panjang, bisa satu kata. Bisa pertanyaan, bisa keluhan.

### Pertukaran
Satu siklus utuh:
> keresahan user → kutipan Rumi muncul → audio kutipan diputar → penjelasan Rumi mengalir → selesai

Satu pertukaran = satu keresahan + satu respons Rumi.

### Sesi (Lembaran Refleksi)
Kumpulan pertukaran yang dikelompokkan jadi satu thread, mirip percakapan ChatGPT. Satu sesi bisa berisi banyak pertukaran dengan topik berbeda. Sesi tersimpan di sidebar dan bisa dibuka lagi kapan saja.

Penting: **Rumi tidak mengingat pertukaran sebelumnya dalam satu sesi**. Frame "sesi" hanya cara mengorganisir riwayat — bukan dialog berkelanjutan.

### Kutipan
Puisi pendek Rumi yang dipilih sistem berdasarkan kedekatan makna dengan keresahan user. Setiap kutipan punya audio narasi yang otomatis diputar saat pertama kali muncul.

### Penjelasan
Tulisan panjang yang muncul kata per kata, seolah Rumi mengetik langsung di hadapan user — menjelaskan bagaimana kutipan tadi berbicara ke keresahan yang ditulis.

### Pose Rumi
Karakter Rumi tampil sebagai ilustrasi yang berganti-ganti pose mengikuti situasi:
- **Mendengar** — saat idle atau menunggu user mengetik
- **Berpikir** — saat sedang mencari kutipan setelah user submit
- **Berbicara** — saat audio diputar atau penjelasan sedang mengalir

Pose ini hidup. Bukan sekadar gambar diam.

---

## 3. Halaman aplikasi

### 3.1 Landing Page (`/`)

Halaman depan untuk pengunjung baru. Tidak ada sidebar, tidak ada chat — hanya pengantar puitis.

**Yang ditampilkan:**
- **Hero** — judul besar dengan tipografi elegan, satu kalimat pengantar tentang Rumi Talk, tombol "Mulai Refleksi"
- **How To Use** — tiga langkah singkat cara pakai (tulis keresahan → terima kutipan → dengarkan & renungkan), masing-masing dengan ilustrasi pose Rumi yang berbeda
- **Footer editorial** — kutipan pendek Rumi sebagai penutup, copyright

Tone: tenang, dramatis, tidak ramai. Animasi fade-in halus saat di-scroll.

### 3.2 Chat — Empty State (`/chat`)

Yang user lihat saat:
- Klik "Mulai Refleksi" dari landing
- Klik tombol "+ New" di sidebar
- Belum punya sesi sama sekali

**Yang ditampilkan:**
- Sidebar (jika ada sesi sebelumnya) atau drawer collapsed di mobile
- Tengah layar: **Rumi besar dalam pose mendengar**, tenang
- Satu kalimat pengantar: *"Mulailah dengan apa yang ada di hatimu."*
- Kolom input keresahan di bawah

Tidak ada quick prompt, tidak ada saran. User memulai dari keheningan.

### 3.3 Chat — Sesi Aktif (`/chat/:sessionId`)

Yang user lihat saat membuka sesi yang sudah ada atau setelah submit pertama.

**Yang ditampilkan:**
- Sidebar dengan daftar sesi (sesi aktif di-highlight)
- Header tipis dengan logo Rumi Talk
- Rumi kecil di atas area chat, pose mengikuti state
- Riwayat pertukaran (scroll vertikal, urutan kronologis)
- Kolom input di bawah, selalu accessible

Saat user scroll naik, semua pertukaran sebelumnya terlihat utuh — tiap pertukaran terdiri dari bubble keresahan user, kartu kutipan Rumi (dengan tombol play audio), dan teks penjelasan.

### 3.4 Sidebar (komponen di semua halaman chat)

**Isi:**
- Tombol "+ New" untuk memulai sesi baru
- Daftar sesi diurutkan dari yang paling baru di-update
- Tiap item menampilkan judul sesi (otomatis dari keresahan pertama, ~60 karakter)
- Klik kanan / tombol tiga titik per item: **Rename** atau **Delete**

**Mobile (≤1024px):** sidebar jadi drawer overlay. Tap hamburger di header untuk buka. Tap backdrop atau tombol close untuk tutup.

---

## 4. Alur user — pertama kali

1. User landing di `/`, baca hero, klik **"Mulai Refleksi"**
2. Masuk ke `/chat` (empty state). Rumi besar mendengar
3. User mengetik keresahan, tekan submit
4. Rumi berganti ke pose **berpikir**, mengecil ke ukuran kompak
5. Kutipan muncul dengan animasi reveal dramatis (kartu emas, tipografi italic)
6. Audio kutipan **otomatis diputar**. Pose Rumi switch ke **berbicara**
7. Setelah audio selesai, penjelasan mulai mengalir kata per kata dengan kursor berkedip
8. Selesai. Pose kembali ke **mendengar**, kursor input siap untuk pertukaran berikutnya
9. URL berubah jadi `/chat/<id-sesi>`. Sidebar update, sesi baru muncul di paling atas

---

## 5. Alur user — kembali lagi

1. User buka aplikasi, langsung ke `/chat` atau diarahkan ke sesi terakhir
2. Sidebar otomatis menampilkan sesi-sesi sebelumnya (terikat ke device, tanpa login)
3. Klik salah satu sesi → semua pertukaran dimuat, tampil utuh
4. Audio **tidak** auto-play di sesi lama (user harus tap manual)
5. User bisa lanjut menulis keresahan baru di sesi yang sama, atau buka sesi lain, atau klik "+ New"

---

## 6. Fitur lengkap

### Inti
- Input keresahan (textarea bebas, Indonesia/Inggris)
- Pencarian kutipan Rumi yang relevan secara semantik
- Tampilan kutipan dengan animasi reveal premium
- Audio narasi kutipan dengan auto-play di pertukaran pertama
- Streaming penjelasan kata per kata (efek seperti Rumi mengetik live)
- Karakter Rumi animatif dengan empat pose dinamis

### Manajemen Sesi
- Daftar sesi tersimpan otomatis (anonim, terikat device)
- Buat sesi baru kapan saja
- Buka kembali sesi lama, lengkap dengan semua pertukaran
- Rename judul sesi manual
- Hapus sesi (dengan konfirmasi)

### Kontrol Streaming
- Tombol **"Berhenti"** muncul saat penjelasan sedang mengalir — user bisa cancel kapan saja
- Saat sedang streaming, input di-block agar tidak menumpuk request
- Jika koneksi putus mid-stream, state bisa di-recover dengan reload halaman

### Responsif
- Desktop (>1024px): sidebar nempel kiri, layout 280px + konten
- Mobile (≤1024px): sidebar jadi drawer overlay, full-width chat
- Animasi tetap halus, mengikuti `prefers-reduced-motion` untuk aksesibilitas

### Visual
- Palet **Deep Night Sky + Gold** — biru tua sebagai latar, emas sebagai aksen
- Tipografi: Cinzel (display), Outfit (body), Cormorant Garamond italic (kutipan)
- Smooth scroll global di landing
- Animasi GSAP untuk transisi pose Rumi, reveal kutipan, fade scroll

---

## 7. Yang TIDAK ada (di MVP)

Eksplisit out-of-scope:
- ❌ Login / akun user — semua anonim
- ❌ Sinkronisasi sesi antar device — sesi terikat ke browser
- ❌ Memori percakapan multi-turn — Rumi tidak ingat pertukaran sebelumnya
- ❌ Search di dalam sesi historis
- ❌ Export sesi ke PDF / markdown
- ❌ Share sesi ke publik / link sharable
- ❌ Quick prompts / saran keresahan
- ❌ Admin panel kutipan dari sisi user
- ❌ Notifikasi / reminder

---

## 8. Tone & filosofi produk

> Setiap detail — typography, jeda animasi, pose Rumi, urutan kemunculan kutipan-audio-penjelasan — dirancang untuk membuat user **berhenti sejenak**. Rumi Talk bukan tempat scroll cepat. Ini tempat duduk diam.

Yang dihindari:
- Gamification, streak, badge
- Notifikasi push
- Saran keresahan / template
- Tone marketing/SaaS yang bersih dingin
- Multi-modal feature creep (gambar, video, dll)

Yang dipeluk:
- Tipografi besar, ruang kosong yang nyaman
- Animasi lambat dan dramatis, bukan snappy
- Audio sebagai bagian utama, bukan tambahan
- Bahasa puitis di setiap micro-copy
