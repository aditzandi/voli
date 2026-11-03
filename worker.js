/* TukarView - Cloudflare Worker + D1
   Aturan: 1 poin = 1 detik tonton. Nonton video orang = dapat poin,
   poin dipakai untuk boost video sendiri (durasi x jumlah view). */

const enc = new TextEncoder();
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const now = () => Math.floor(Date.now() / 1000);
const DURS = [10, 30, 60, 120];
const ytid = u => { const m = String(u || '').match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/); return m ? m[1] : null; };

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
async function sha(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
const isAdmin = (env, tg) => String(env.ADMIN_IDS || '').split(',').map(s => s.trim()).includes(String(tg));

/* Verifikasi initData Telegram Mini App (HMAC resmi) */
async function tgUser(req, env) {
  const raw = (req.headers.get('Authorization') || '').replace(/^tma /, '');
  if (env.DEV_MODE === '1' && req.headers.get('x-dev-user')) {
    return { user: JSON.parse(req.headers.get('x-dev-user')), start: '' };
  }
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = await hmac(enc.encode('WebAppData'), env.BOT_TOKEN);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  if (now() - Number(p.get('auth_date')) > 86400) return null;
  try { return { user: JSON.parse(p.get('user')), start: p.get('start_param') || '' }; } catch { return null; }
}

const ledger = (env, uid, delta, reason) =>
  env.DB.prepare('INSERT INTO ledger(user_id,delta,reason,t) VALUES(?,?,?,?)').bind(uid, delta, reason, now());

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try { return await api(req, env, url); }
    catch (e) { return J({ error: 'Terjadi kesalahan server.' }, 500); }
  }
};

async function api(req, env, url) {
  const p = url.pathname.slice(5);
  const t = await tgUser(req, env);
  if (!t) return J({ error: 'Buka aplikasi lewat Telegram.' }, 401);
  const DB = env.DB;
  const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  let u = await DB.prepare('SELECT * FROM users WHERE tg_id=?').bind(t.user.id).first();

  /* ---- pendaftaran otomatis + aturan 1 IP ---- */
  if (!u) {
    const ip = req.headers.get('CF-Connecting-IP') || '';
    const h = await sha(ip + (env.IP_SALT || ''));
    if (!isAdmin(env, t.user.id)) {
      const lim = parseInt(env.IP_LIMIT || '1');
      const c = await DB.prepare('SELECT COUNT(*) n FROM users WHERE ip_hash=?').bind(h).first();
      if (c.n >= lim) return J({ error: 'Satu IP hanya boleh satu akun. IP ini sudah dipakai akun lain.' }, 403);
    }
    let ref = null;
    if (/^ref_\d+$/.test(t.start)) {
      const r = await DB.prepare('SELECT id,tg_id FROM users WHERE tg_id=?').bind(t.start.slice(4)).first();
      if (r && r.tg_id !== t.user.id) ref = r.id;
    }
    const bonus = parseInt(env.BONUS_DAFTAR || '60');
    const name = [t.user.first_name, t.user.last_name].filter(Boolean).join(' ').slice(0, 60);
    await DB.prepare('INSERT INTO users(tg_id,name,username,ip_hash,poin,ref_by,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(t.user.id, name, t.user.username || '', h, bonus, ref, now()).run();
    u = await DB.prepare('SELECT * FROM users WHERE tg_id=?').bind(t.user.id).first();
    await ledger(env, u.id, bonus, 'bonus daftar').run();
  }
  if (u.status !== 'aktif') return J({ error: 'Akun diblokir.' }, 403);

  switch (p) {
    case 'me': {
      const refs = await DB.prepare('SELECT COUNT(*) n FROM users WHERE ref_by=?').bind(u.id).first();
      return J({ id: u.id, tg_id: u.tg_id, name: u.name, poin: u.poin, refs: refs.n, bot: env.BOT_USERNAME, admin: isAdmin(env, u.tg_id) });
    }

    case 'videos': {
      const r = await DB.prepare(`SELECT v.id,v.yt_id,v.detik FROM videos v
        WHERE v.status='aktif' AND v.sisa>0 AND v.owner_id!=?1
        AND v.yt_id NOT IN (SELECT yt_id FROM views WHERE user_id=?1)
        AND v.yt_id NOT IN (SELECT yt_id FROM videos WHERE owner_id=?1)
        ORDER BY v.created_at LIMIT 30`).bind(u.id).all();
      return J({ videos: r.results });
    }

    case 'start': {
      const v = await DB.prepare("SELECT * FROM videos WHERE id=? AND status='aktif' AND sisa>0").bind(b.video_id).first();
      if (!v) return J({ error: 'Video tidak tersedia.' }, 404);
      if (v.owner_id === u.id) return J({ error: 'Tidak bisa menonton video sendiri.' }, 403);
      const own = await DB.prepare('SELECT 1 x FROM videos WHERE owner_id=? AND yt_id=?').bind(u.id, v.yt_id).first();
      if (own) return J({ error: 'Tidak bisa menonton video milik sendiri.' }, 403);
      const dup = await DB.prepare('SELECT 1 x FROM views WHERE user_id=? AND yt_id=?').bind(u.id, v.yt_id).first();
      if (dup) return J({ error: 'Video ini sudah pernah Anda tonton.' }, 409);
      await DB.prepare('DELETE FROM sessions WHERE user_id=? AND done=0').bind(u.id).run();
      const sid = crypto.randomUUID(), n = now();
      await DB.prepare('INSERT INTO sessions(id,user_id,video_id,started,last_hb,played,done) VALUES(?,?,?,?,?,0,0)')
        .bind(sid, u.id, v.id, n, n).run();
      return J({ sid, yt: v.yt_id, detik: v.detik });
    }

    /* heartbeat: server hanya menambah waktu dari selisih jam server, tidak percaya angka dari klien */
    case 'hb': {
      const s = await DB.prepare('SELECT * FROM sessions WHERE id=? AND user_id=? AND done=0').bind(b.sid, u.id).first();
      if (!s) return J({ error: 'Sesi tidak valid.' }, 400);
      const n = now(), dt = n - s.last_hb;
      const add = (b.playing && dt >= 1 && dt <= 10) ? Math.min(dt, 7) : 0;
      await DB.prepare('UPDATE sessions SET last_hb=?, played=played+? WHERE id=?').bind(n, add, s.id).run();
      return J({ played: s.played + add });
    }

    case 'finish': {
      const s = await DB.prepare('SELECT * FROM sessions WHERE id=? AND user_id=? AND done=0').bind(b.sid, u.id).first();
      if (!s) return J({ error: 'Sesi tidak valid.' }, 400);
      const v = await DB.prepare('SELECT * FROM videos WHERE id=?').bind(s.video_id).first();
      if (!v || v.owner_id === u.id) return J({ error: 'Video tidak valid.' }, 400);
      if (now() - s.started < v.detik || s.played < v.detik * 0.8)
        return J({ error: 'Durasi tonton belum terpenuhi.', played: s.played }, 400);
      const r = await DB.prepare('UPDATE sessions SET done=1 WHERE id=? AND done=0').bind(s.id).run();
      if (!r.meta.changes) return J({ error: 'Sesi sudah dipakai.' }, 400);
      try {
        await DB.prepare('INSERT INTO views(user_id,video_id,yt_id,t) VALUES(?,?,?,?)').bind(u.id, v.id, v.yt_id, now()).run();
      } catch (e) { return J({ error: 'Video ini sudah pernah Anda tonton.' }, 409); }
      await DB.batch([
        DB.prepare('UPDATE videos SET sisa=sisa-1 WHERE id=? AND sisa>0').bind(v.id),
        DB.prepare("UPDATE videos SET status='selesai' WHERE id=? AND sisa<=0").bind(v.id),
        DB.prepare('UPDATE users SET poin=poin+? WHERE id=?').bind(v.detik, u.id),
        ledger(env, u.id, v.detik, 'nonton video ' + v.detik + ' dtk')
      ]);
      /* bonus referral: sekali, saat undangan menyelesaikan view pertamanya */
      const nv = await DB.prepare('SELECT COUNT(*) n FROM views WHERE user_id=?').bind(u.id).first();
      if (nv.n === 1 && u.ref_by) {
        const rb = parseInt(env.BONUS_REFERRAL || '30');
        await DB.batch([
          DB.prepare('UPDATE users SET poin=poin+? WHERE id=?').bind(rb, u.ref_by),
          ledger(env, u.ref_by, rb, 'bonus referral')
        ]);
      }
      return J({ got: v.detik, poin: u.poin + v.detik });
    }

    case 'boost': {
      const y = ytid(b.url), d = Number(b.detik), n = parseInt(b.views);
      if (!y) return J({ error: 'Link YouTube tidak valid.' }, 400);
      if (!DURS.includes(d)) return J({ error: 'Durasi tidak valid.' }, 400);
      if (!(n >= 1 && n <= 500)) return J({ error: 'Jumlah view 1 sampai 500.' }, 400);
      const act = await DB.prepare("SELECT COUNT(*) n FROM videos WHERE owner_id=? AND status='aktif'").bind(u.id).first();
      if (act.n >= 5) return J({ error: 'Maksimal 5 boost aktif.' }, 400);
      const dupe = await DB.prepare("SELECT 1 x FROM videos WHERE yt_id=? AND status='aktif'").bind(y).first();
      if (dupe) return J({ error: 'Video ini sudah ada di antrian.' }, 409);
      const cost = d * n;
      const r = await DB.prepare('UPDATE users SET poin=poin-? WHERE id=? AND poin>=?').bind(cost, u.id, cost).run();
      if (!r.meta.changes) return J({ error: 'Poin tidak cukup. Butuh ' + cost + ' poin.' }, 400);
      await DB.batch([
        DB.prepare('INSERT INTO videos(owner_id,yt_id,detik,target,sisa,status,created_at) VALUES(?,?,?,?,?,?,?)').bind(u.id, y, d, n, n, 'aktif', now()),
        ledger(env, u.id, -cost, 'boost ' + n + ' view x ' + d + ' dtk')
      ]);
      return J({ ok: true, poin: u.poin - cost });
    }

    case 'cancel': {
      const v = await DB.prepare("SELECT * FROM videos WHERE id=? AND owner_id=? AND status='aktif'").bind(b.video_id, u.id).first();
      if (!v) return J({ error: 'Boost tidak ditemukan.' }, 404);
      const back = v.sisa * v.detik;
      await DB.batch([
        DB.prepare("UPDATE videos SET status='batal', sisa=0 WHERE id=?").bind(v.id),
        DB.prepare('UPDATE users SET poin=poin+? WHERE id=?').bind(back, u.id),
        ledger(env, u.id, back, 'refund boost')
      ]);
      return J({ refund: back });
    }

    case 'mine': {
      const vs = await DB.prepare('SELECT id,yt_id,detik,target,sisa,status FROM videos WHERE owner_id=? ORDER BY id DESC LIMIT 20').bind(u.id).all();
      const lg = await DB.prepare('SELECT delta,reason,t FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 20').bind(u.id).all();
      return J({ videos: vs.results, ledger: lg.results });
    }
  }

  /* ---------------- ADMIN: daftar member ---------------- */
  if (p.startsWith('admin/')) {
    if (!isAdmin(env, u.tg_id)) return J({ error: 'Bukan admin.' }, 403);
    if (p === 'admin/members') {
      const q = '%' + (url.searchParams.get('q') || '') + '%';
      const pg = Math.max(0, parseInt(url.searchParams.get('page') || '0'));
      const rows = await DB.prepare(`SELECT id,tg_id,name,username,poin,status,created_at,
        (SELECT COUNT(*) FROM views WHERE user_id=users.id) views
        FROM users WHERE name LIKE ?1 OR username LIKE ?1 OR CAST(tg_id AS TEXT) LIKE ?1
        ORDER BY id DESC LIMIT 15 OFFSET ?2`).bind(q, pg * 15).all();
      const st = await DB.prepare("SELECT COUNT(*) total, SUM(status!='aktif') blokir, SUM(created_at>?) hari FROM users").bind(now() - 86400).first();
      return J({ members: rows.results, stats: st });
    }
    if (p === 'admin/status') {
      await DB.prepare('UPDATE users SET status=? WHERE id=?').bind(b.status === 'blokir' ? 'blokir' : 'aktif', b.id).run();
      return J({ ok: true });
    }
    if (p === 'admin/poin') {
      const d = parseInt(b.delta) || 0;
      if (!d) return J({ error: 'Nominal kosong.' }, 400);
      await DB.batch([
        DB.prepare('UPDATE users SET poin=MAX(0,poin+?) WHERE id=?').bind(d, b.id),
        ledger(env, b.id, d, 'penyesuaian admin')
      ]);
      return J({ ok: true });
    }
  }
  return J({ error: 'Tidak ditemukan.' }, 404);
}
