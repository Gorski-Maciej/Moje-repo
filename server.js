require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3443;

const upload = multer({ dest: 'uploads/tmp/' });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: 'tajny-klucz-sesji-uploader',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true }
}));

// ---- Middleware logujący każde żądanie ----
app.use((req, res, next) => {
  console.log(`--> ${req.method} ${req.url}`);
  next();
});

app.use(express.static('public'));

// ---- Pomocnicze ----

async function fetchWD(url, token, options = {}) {
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${sep}wdauth=${token}`;
  console.log(`[WD REQUEST] GET ${fullUrl}`);
  const res = await fetch(fullUrl, options);
  const data = await res.json();
  console.log(`[WD RESPONSE]`, data);
  return data;
}

function pluralFiles(count) {
  const m10 = count % 10, m100 = count % 100;
  if (m10 === 1 && m100 !== 11) return `${count} plik`;
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return `${count} pliki`;
  return `${count} plików`;
}

// Udostępnienie helpera w szablonach
app.locals.pluralFiles = pluralFiles;

const requireAuth = (req, res, next) => req.session.token ? next() : res.redirect('/login');

// ---- Trasy ----

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', async (req, res) => {
  const { album, password } = req.body;
  const md5pass = crypto.createHash('md5').update(password).digest('hex');
  try {
    const authUrl = `https://dziekanat.wsi.edu.pl/get/wd-auth/auth?album=${album}&pass=${md5pass}`;
    console.log(`[AUTH] ${authUrl}`);
    const authRes = await fetch(authUrl);
    let token = (await authRes.text()).trim();
    token = token.replace(/^"/, '').replace(/"$/, '');
    console.log('[AUTH TOKEN]', token);

    if (!token) {
      console.log('Auth error: pusty token');
      return res.render('login', { error: 'Nieprawidłowe dane logowania.' });
    }

    const user = await fetchWD('https://dziekanat.wsi.edu.pl/get/wd-auth/user', token);
    if (!user || !user.studentid) {
      console.log('Nie udało się pobrać danych użytkownika – token niepoprawny');
      return res.render('login', { error: 'Błąd autoryzacji – nieprawidłowy token.' });
    }

    req.session.token = token;
    req.session.user = user;
    req.session.studentid = user.studentid;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Błąd połączenia z WD.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireAuth, async (req, res) => {
  const token = req.session.token;
  const studentid = req.session.studentid;
  try {
    const [notes, lectures, teachers, allCats, userFilesRaw] = await Promise.all([
      fetchWD(`https://dziekanat.wsi.edu.pl/get/wd-news/student/${studentid}/notes`, token),
      fetchWD('https://dziekanat.wsi.edu.pl/get/wd-news/lectures', token),
      fetchWD('https://dziekanat.wsi.edu.pl/get/wd-news/teachers', token),
      fetchWD('https://doha.wsi.edu.pl:10005/cats?active=false', token),
      fetchWD(`https://doha.wsi.edu.pl:10005/uploadz?catid=0&userid=${studentid}&after=0`, token)
    ]);

    const userFiles = Array.isArray(userFilesRaw) ? userFilesRaw : [];

    const lectureMap = new Map(lectures.map(l => [l.przedmiotid, l.nazwa]));
    const teacherMap = new Map(teachers.map(t => [t.wykladowcaid, `${t.prefix ? t.prefix + ' ' : ''}${t.imie} ${t.nazwisko}${t.suffix ? ', ' + t.suffix : ''}`]));

    const studentLectures = [];
    const subjectNames = new Set();
    notes.forEach(n => {
      const name = lectureMap.get(n.przedmiotid);
      if (name) {
        subjectNames.add(name);
        studentLectures.push({ przedmiot: name, wykladowca: teacherMap.get(n.wykladowcaid) || 'Nieznany' });
      }
    });

    const normalize = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const matched = allCats.filter(cat => {
      const cn = normalize(cat.name);
      return [...subjectNames].some(sn => cn.includes(normalize(sn)) || normalize(sn).includes(cn));
    });

    const fileCount = {};
    userFiles.forEach(f => { fileCount[f.catid] = (fileCount[f.catid] || 0) + 1; });

    const categoriesWithCounts = matched.map(cat => ({
      ...cat,
      fileCount: fileCount[cat.catid] || 0
    }));

    const totalFiles = userFiles.length;

    res.render('dashboard', {
      user: req.session.user,
      studentLectures,
      categoriesWithCounts,
      totalFiles,
      fileLabel: pluralFiles(totalFiles),
      noFiles: totalFiles === 0
    });
  } catch (err) {
    console.error(err);
    res.render('dashboard', {
      user: req.session.user,
      studentLectures: [],
      categoriesWithCounts: [],
      totalFiles: 0,
      fileLabel: '0 plików',
      noFiles: true
    });
  }
});

app.get('/api/categories', requireAuth, async (req, res) => {
  try {
    const token = req.session.token;
    const studentid = req.session.studentid;
    const [notes, lectures, cats] = await Promise.all([
      fetchWD(`https://dziekanat.wsi.edu.pl/get/wd-news/student/${studentid}/notes`, token),
      fetchWD('https://dziekanat.wsi.edu.pl/get/wd-news/lectures', token),
      fetchWD('https://doha.wsi.edu.pl:10005/cats?active=false', token)
    ]);
    const lectureMap = new Map(lectures.map(l => [l.przedmiotid, l.nazwa]));
    const names = new Set();
    notes.forEach(n => { const nm = lectureMap.get(n.przedmiotid); if (nm) names.add(nm); });
    const normalize = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const result = cats.filter(c => {
      const cn = normalize(c.name);
      return [...names].some(sn => cn.includes(normalize(sn)) || normalize(sn).includes(cn));
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Błąd pobierania kategorii' });
  }
});

app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const { catid = 0, userid = 0, after } = req.query;
    let url = `https://doha.wsi.edu.pl:10005/uploadz?catid=${catid}&userid=${userid}`;
    url += after ? `&after=${after}` : '&after=0';
    res.json(await fetchWD(url, req.session.token));
  } catch (err) {
    res.status(500).json({ error: 'Błąd' });
  }
});

app.get('/api/my-files-per-category', requireAuth, async (req, res) => {
  try {
    const token = req.session.token;
    const studentid = req.session.studentid;
    const [filesRaw, cats] = await Promise.all([
      fetchWD(`https://doha.wsi.edu.pl:10005/uploadz?catid=0&userid=${studentid}&after=0`, token),
      fetchWD('https://doha.wsi.edu.pl:10005/cats?active=false', token)
    ]);
    const files = Array.isArray(filesRaw) ? filesRaw : [];
    const countMap = {};
    files.forEach(f => { countMap[f.catid] = (countMap[f.catid] || 0) + 1; });
    const result = cats.map(c => ({ catid: c.catid, name: c.name, fileCount: countMap[c.catid] || 0 }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Błąd' });
  }
});

app.get('/api/my-files-count', requireAuth, async (req, res) => {
  try {
    const token = req.session.token;
    const studentid = req.session.studentid;
    const filesRaw = await fetchWD(`https://doha.wsi.edu.pl:10005/uploadz?catid=0&userid=${studentid}&after=0`, token);
    const files = Array.isArray(filesRaw) ? filesRaw : [];
    const count = files.length;
    res.json({ count, label: pluralFiles(count) });
  } catch (err) {
    res.status(500).json({ error: 'Błąd' });
  }
});

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    res.json(await fetchWD('https://doha.wsi.edu.pl:10005/allusers', req.session.token));
  } catch (err) {
    res.status(500).json({ error: 'Błąd' });
  }
});

app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Brak pliku' });
    const catid = req.body.catid;
    if (!catid) return res.status(400).json({ error: 'Brak catid' });

    const form = new FormData();
    form.append('file', fs.createReadStream(req.file.path), {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });

    const uploadUrl = `https://doha.wsi.edu.pl:10005/uploads?wdauth=${req.session.token}&catid=${catid}`;
    console.log('[UPLOAD]', uploadUrl);
    const response = await fetch(uploadUrl, { method: 'POST', body: form, headers: form.getHeaders() });

    fs.unlink(req.file.path, () => {});

    if (!response.ok) {
      const errText = await response.text();
      console.error('[UPLOAD ERROR]', errText);
      return res.status(response.status).json({ error: errText });
    }
    res.json(await response.json());
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    console.error(err);
    res.status(500).json({ error: 'Błąd wysyłania pliku' });
  }
});

const options = {
  key: fs.readFileSync('certs/server.key'),
  cert: fs.readFileSync('certs/server.crt')
};
https.createServer(options, app).listen(PORT, () => {
  console.log(`Uploader działa na https://localhost:${PORT}`);
});