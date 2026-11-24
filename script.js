(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  // Les affiches ne se « glissent » plus : plus de fantôme d'image au clic
  document.addEventListener("dragstart", (e) => { if (e.target && e.target.tagName === "IMG") e.preventDefault(); });

  let films = [];        // {name, year}
  let rewatches = [];    // {name, year}, lignes "Rewatch" du journal
  let ratings = null;    // Map "nom|année" -> note, ou null sans ratings.csv
  let likes = null;      // Set "nom|année", ou null
  let likeDates = [];   // {k: "nom|année", d: date du coup de cœur}, d'après likes.csv
  let diaryRows = [], watchlist = [], username = "", favorites = [];   // journal, pseudo Letterboxd, liens du top 4
  let running = false, cancelled = false;

  const CACHE_KEY = "lb-film-cache-v5", PEOPLE_KEY = "lb-people-v5";   // v5 : casting complet, avec identifiants
  let cache = {}, people = {};                                          // people : identifiant TMDB -> nom
  // Les données TMDB gardées dans ce navigateur sont purgées au bout de 6 mois, puis recalculées à la demande
  const STAMP_KEY = "lb-cache-stamp", MAX_AGE = 180 * 864e5;
  try {
    const st = +localStorage.getItem(STAMP_KEY) || 0;
    if (st && Date.now() - st > MAX_AGE) ["lb-film-cache-v5", "lb-people-v5", "lb-person-v1", "lb-coll-v1", STAMP_KEY].forEach((k) => localStorage.removeItem(k));
    if (!localStorage.getItem(STAMP_KEY)) localStorage.setItem(STAMP_KEY, String(Date.now()));
  } catch (e) {}
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch (e) {}
  try { people = JSON.parse(localStorage.getItem(PEOPLE_KEY) || "{}"); } catch (e) {}
  const saveCache = () => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); localStorage.setItem(PEOPLE_KEY, JSON.stringify(people)); } catch (e) {}
  };
  const keyOf = (f) => f.name + "|" + f.year;

  const nf = new Intl.NumberFormat("fr-FR");
  const nf1 = (x) => x.toFixed(1).replace(".", ",");
  const regionNames = new Intl.DisplayNames(["fr"], { type: "region" });
  const langNames = new Intl.DisplayNames(["fr"], { type: "language" });
  // Anciens pays que TMDB code encore (l'API de noms les confondrait avec les pays actuels)
  const LEGACY = { SU: "Union soviétique", XC: "Tchécoslovaquie", DD: "Allemagne de l'Est", YU: "Yougoslavie", CS: "Serbie-et-Monténégro", XK: "Kosovo" };
  const safeName = (dn, code) => {
    if (dn === regionNames && LEGACY[code]) return LEGACY[code];
    try { return dn.of(code) || code; } catch (e) { return code; }
  };

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(f); f = ""; rows.push(row); row = [];
      } else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    const head = rows.shift() || [];
    return rows.filter((r) => r.length > 1).map((r) => {
      const o = {}; head.forEach((h, k) => { o[h.trim()] = r[k] || ""; }); return o;
    });
  }

  /* ---------- Fichier ---------- */
  function showErr(m) { $("err").textContent = m; $("err").hidden = false; }

  function load(texts, name) {
    films = parseCSV(texts.watched).filter((r) => r.Name).map((r) => ({ name: r.Name, year: r.Year, uri: (r["Letterboxd URI"] || "").trim() }));
    diaryRows = texts.diary
      ? parseCSV(texts.diary).filter((r) => r.Name).map((r) => ({ name: r.Name, year: r.Year, date: r["Watched Date"] || "", rewatch: r.Rewatch === "Yes", tags: (r.Tags || "").split(",").map((t) => t.trim()).filter(Boolean) }))
      : [];
    rewatches = diaryRows.filter((r) => r.rewatch);
    watchlist = texts.watchlist
      ? parseCSV(texts.watchlist).filter((r) => r.Name).map((r) => ({ name: r.Name, year: r.Year, date: r.Date || "", uri: (r["Letterboxd URI"] || "").trim() }))
      : [];
    username = ""; favorites = [];
    if (texts.profile) {
      const p = parseCSV(texts.profile)[0];
      if (p && p.Username) username = p.Username;
      // Colonne « Favorite Films » : jusqu'à 4 liens boxd.it ; sans lien, rien à afficher
      if (p && p["Favorite Films"]) favorites = p["Favorite Films"].split(/[,\s]+/).map((u) => u.replace(/\/$/, "")).filter((u) => /^https?:\/\//.test(u)).slice(0, 4);
    }
    ratings = null; likes = null; likeDates = [];
    if (texts.ratings) {
      ratings = new Map();
      parseCSV(texts.ratings).forEach((r) => { const v = parseFloat(r.Rating); if (r.Name && !isNaN(v)) ratings.set(r.Name + "|" + r.Year, v); });
    }
    if (texts.likes) {
      likes = new Set();
      parseCSV(texts.likes).forEach((r) => { if (r.Name) { likes.add(r.Name + "|" + r.Year); likeDates.push({ k: r.Name + "|" + r.Year, d: r.Date || "" }); } });
    }
    if (!films.length) { showErr("Aucun film trouvé dans ce fichier. Il faut watched.csv, ou le ZIP complet."); return; }
    $("drop").classList.add("ok");
    $("dropTitle").textContent = name;
    $("dropSub").textContent = films.length + " films distincts"
      + (ratings ? ", " + ratings.size + " notes" : ", sans notes (dépose le ZIP pour les avoir)");
    $("rewatchRow").hidden = !rewatches.length;
    $("rewatchN").textContent = rewatches.length;
    $("csvWarn").hidden = !!texts.diary || !!texts.profile || /\.zip$/i.test(name);
    yearChoice = null;
    resetDuel();
    update();
  }

  function setFile(file) {
    $("err").hidden = true;
    if (/\.zip$/i.test(file.name)) {
      if (!window.JSZip) { showErr("Le lecteur de ZIP n'a pas pu se charger. Dépose plutôt watched.csv."); return; }
      JSZip.loadAsync(file).then((zip) => {
        const get = (p) => { const f = zip.file(p); return f ? f.async("string") : Promise.resolve(""); };
        if (!zip.file("watched.csv")) { showErr("watched.csv est introuvable dans ce ZIP."); return; }
        return Promise.all([get("watched.csv"), get("diary.csv"), get("ratings.csv"), get("likes/films.csv"), get("profile.csv"), get("watchlist.csv")])
          .then((t) => load({ watched: t[0], diary: t[1], ratings: t[2], likes: t[3], profile: t[4], watchlist: t[5] }, file.name));
      }).catch(() => showErr("Impossible de lire ce ZIP."));
    } else {
      const rd = new FileReader();
      rd.onload = () => load({ watched: String(rd.result) }, file.name);
      rd.readAsText(file);
    }
  }

  const drop = $("drop");
  $("file").addEventListener("change", (e) => { if (e.target.files[0]) setFile(e.target.files[0]); });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

  function update() { $("go").disabled = running || !films.length || $("key").value.trim().length < 20; }
  // Mémorisation de la clé TMDB dans ce navigateur (comme un mot de passe enregistré), désactivable
  const KEY_STORE = "lb-tmdb-key", REMEMBER_OFF = "lb-tmdb-remember-off";
  try {
    $("remember").checked = localStorage.getItem(REMEMBER_OFF) !== "1";
    const saved = localStorage.getItem(KEY_STORE);
    if (saved && $("remember").checked) $("key").value = saved;
  } catch (e) {}
  function persistKey() {
    try {
      const k = $("key").value.trim();
      if ($("remember").checked) { localStorage.removeItem(REMEMBER_OFF); if (k) localStorage.setItem(KEY_STORE, k); }
      else { localStorage.removeItem(KEY_STORE); localStorage.setItem(REMEMBER_OFF, "1"); }
    } catch (e) {}
  }
  $("key").addEventListener("input", () => { update(); persistKey(); });
  $("remember").addEventListener("change", persistKey);

  /* ---------- TMDB ---------- */
  function tmdb(path, params, key) {
    const url = new URL("https://api.themoviedb.org/3/" + path);
    const opts = {};
    Object.keys(params || {}).forEach((k) => url.searchParams.set(k, params[k]));
    if (key.length > 40) opts.headers = { Authorization: "Bearer " + key };
    else url.searchParams.set("api_key", key);
    return fetch(url, opts).then((r) => {
      if (r.status === 401) { const e = new Error("auth"); e.fatal = true; throw e; }
      if (r.status === 429) {
        const wait = (parseInt(r.headers.get("Retry-After"), 10) || 2) * 1000;
        return new Promise((ok) => setTimeout(ok, wait)).then(() => tmdb(path, params, key));
      }
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    });
  }
  const norm = (t) => (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const relYear = (m) => parseInt((m.release_date || "").slice(0, 4), 10);
  // Choisit le film dont l'année colle (à 1 an près), puis dont le titre est identique, puis le plus populaire.
  // Un film d'une autre année (ex. un remake) n'est jamais retenu.
  function bestMatch(results, film) {
    const y = parseInt(film.year, 10), n = norm(film.name);
    let best = null, bs = 1e9;
    results.forEach((m, i) => {
      const d = isNaN(relYear(m)) ? 99 : Math.abs(relYear(m) - y);
      if (d > 1) return;
      const t = (norm(m.title) === n || norm(m.original_title) === n) ? 0 : 1;
      const sc = d * 100 + t * 10 + i * 0.01;
      if (sc < bs) { bs = sc; best = m; }
    });
    return best;
  }
  // Corrections manuelles : fichier corrections.js (window.TMDB_FIXES) + celles saisies dans ce navigateur
  const FIX_KEY = "lb-fixes-v1";
  let fixes = Object.assign({}, window.TMDB_FIXES || {});
  try { Object.assign(fixes, JSON.parse(localStorage.getItem(FIX_KEY) || "{}")); } catch (e) {}
  const saveFixes = () => { try { localStorage.setItem(FIX_KEY, JSON.stringify(fixes)); } catch (e) {} };
  function lookup(film, key) {
    const fx = fixes[film.name + "|" + film.year];
    if (fx) return fetchById(+fx, key);
    return tmdb("search/movie", { query: film.name, primary_release_year: film.year }, key)
      .then((r) => bestMatch(r.results, film) || tmdb("search/movie", { query: film.name }, key).then((r2) => bestMatch(r2.results, film)))
      .then((m) => (m ? fetchById(m.id, key) : { ok: 0 }));
  }
  function fetchById(id, key) {
    return Promise.resolve(id)
      .then((mid) => {
        return tmdb("movie/" + mid, { language: "fr-FR", append_to_response: "credits" }, key).then((d) => {
          const cast = (d.credits && d.credits.cast) || [];
          const crew = ((d.credits && d.credits.crew) || []).filter((x) => x.job === "Director");
          cast.concat(crew).forEach((x) => { people[x.id] = x.name; });
          const major = cast.slice(0, 5);
          const ids = (list, g) => list.filter((x) => x.gender === g).map((x) => x.id);
          return {
            ok: 1,
            rt: d.runtime || 0,
            g: (d.genres || []).map((x) => x.name),
            d: crew.map((x) => x.id),
            m: ids(major, 2),                                                // acteurs en rôle majeur (5 premiers du générique)
            f: ids(major, 1),                                                // actrices en rôle majeur
            u: major.filter((x) => x.gender !== 1 && x.gender !== 2).map((x) => x.id),
            o: cast.slice(5).map((x) => x.id),                               // tous les autres rôles du générique
            c: (d.production_countries || []).map((x) => x.iso_3166_1),
            l: d.original_language || "",
            v: d.vote_average || 0,
            n: d.vote_count || 0,
            p: d.poster_path || "",
            i: d.id,
            col: d.belongs_to_collection ? d.belongs_to_collection.id : 0,    // saga / franchise TMDB
            cn: d.belongs_to_collection ? d.belongs_to_collection.name : "",
            rd: d.release_date || "",
            t: cast.slice(0, 3).map((x) => x.id)                             // 3 premiers rôles du générique
          };
        });
      });
  }

  /* ---------- Calcul ---------- */
  $("stop").addEventListener("click", () => { cancelled = true; });

  $("go").addEventListener("click", () => {
    const key = $("key").value.trim();
    const have = new Set(films.map(keyOf)), seenWl = new Set();
    const queue = films.concat(watchlist.filter((f) => { const k = keyOf(f); if (have.has(k) || seenWl.has(k)) return false; seenWl.add(k); return true; }));
    const total = queue.length;
    let done = 0, fetched = 0, fatal = false;
    const startedAt = Date.now();
    const needsRequest = (f) => {
      const k = keyOf(f), c = cache[k];
      return !(k in cache) || (fixes[k] && !(c && c.ok && c.i === +fixes[k])) || (c && c.ok && c.col === undefined && !c.i) || (c && c.ok && c.col === undefined);
    };
    const requestTotal = queue.filter(needsRequest).length;
    let etaSeconds = requestTotal ? Math.max(10, Math.ceil((requestTotal / 3) / 10) * 10) : 5;
    let etaTimer = null;
    const formatEta = (seconds) => {
      const rounded = Math.max(0, Math.ceil(seconds / 10) * 10);
      if (rounded < 60) return "environ " + rounded + " s";
      const mins = Math.floor(rounded / 60), secs = rounded % 60;
      return "environ " + mins + " min" + (secs ? " " + secs + " s" : "");
    };
    const refreshEta = () => {
      if (fetched >= 6) {
        const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
        const rate = fetched / elapsed;
        etaSeconds = Math.max(0, (requestTotal - fetched) / rate);
      } else {
        etaSeconds = Math.max(0, etaSeconds - 1);
      }
      $("etaText").textContent = requestTotal
        ? "Temps restant estimé : " + formatEta(etaSeconds) + " · estimation indicative"
        : "Données déjà en cache : calcul presque terminé.";
    };
    running = true; cancelled = false; update();
    $("go").hidden = true; $("stop").hidden = false; $("progress").hidden = false;
    $("err").hidden = true; $("results").hidden = true;

    const tick = () => {
      $("fill").style.width = (done / total * 100) + "%";
      $("progText").textContent = done + " / " + total + " films analysés";
      refreshEta();
    };
    tick();
    etaTimer = setInterval(refreshEta, 1000);

    const worker = () => {
      if (cancelled || fatal || !queue.length) return Promise.resolve();
      const f = queue.shift(), k = keyOf(f);
      const c0 = cache[k];
      let p, didRequest = false;
      if (!(k in cache) || (c0 && c0.ok && c0.col === undefined && !c0.i) || (fixes[k] && !(c0 && c0.ok && c0.i === +fixes[k]))) { didRequest = true; p = lookup(f, key).then((res) => { cache[k] = res; }); }
      else if (c0 && c0.ok && c0.col === undefined) {
        didRequest = true;
        // Ancienne entrée du cache : on ne récupère que la collection (saga) du film
        p = tmdb("movie/" + c0.i, { language: "fr-FR" }, key).then((d) => {
          c0.col = d.belongs_to_collection ? d.belongs_to_collection.id : 0;
          c0.cn = d.belongs_to_collection ? d.belongs_to_collection.name : "";
        });
      } else p = Promise.resolve();
      return p.catch((e) => { if (e.fatal) fatal = true; })
        .then(() => { done++; if (didRequest) fetched++; if (done % 5 === 0) { tick(); saveCache(); } return worker(); });
    };
    Promise.all([1, 2, 3, 4, 5, 6].map(worker)).then(() => {
      if (etaTimer) clearInterval(etaTimer);
      saveCache(); tick();
      running = false; $("go").hidden = false; $("stop").hidden = true; update();
      if (fatal) { showErr("TMDB a refusé la clé. Retourne sur themoviedb.org > Paramètres > API et copie la valeur « Clé API » en entier, sans espace."); $("progress").hidden = true; return; }
      if (cancelled) { $("progText").textContent = "Arrêté à " + done + " / " + total + ". Relance pour reprendre là où tu t'étais arrêté."; $("etaText").textContent = "Tu pourras reprendre : les données déjà récupérées sont conservées."; return; }
      $("etaText").textContent = "Analyse terminée ! Préparation de tes statistiques…";
      render();
    });
  });
  $("rewatch").addEventListener("change", () => { if (!$("results").hidden && !running) render(); });


  /* ---------- Choix du thème (retenu dans ce navigateur) ---------- */
  const THEMES = [
    { id: "cinematic", name: "Western électrique", sub: "encre, ivoire et ambre", bg: "#111316", pn: "#1a1d21", ac: "#e5b65c", a2: "#d77b68", bd: "#303238" },
    { id: "vintage", name: "Affiche vintage", sub: "clair, papier et encre", bg: "#efe4cc", pn: "#faf3e3", ac: "#d9482b", a2: "#2b5a8a", bd: "#1c1a17" },
    { id: "neon", name: "Néon de nuit", sub: "sombre, rose et cyan", bg: "#0e0a1f", pn: "#181233", ac: "#ff3ea5", a2: "#35e0ff", bd: "#3a2d73" },
    { id: "sauge", name: "Sauge et terre cuite", sub: "clair et doux", bg: "#e9efe6", pn: "#fbfdf9", ac: "#2f6b4f", a2: "#c47a2a", bd: "#cdd9ca" }
  ];
  const THEME_KEY = "lb-theme-v1";
  (function initThemes() {
    const root = document.documentElement, box = $("themes");
    let cur = root.getAttribute("data-theme");
    if (!THEMES.some((t) => t.id === cur)) cur = "cinematic";
    const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const btns = THEMES.map((t) => {
      const b = mk("button", "theme-opt"); b.type = "button"; b.setAttribute("role", "radio"); b.dataset.id = t.id;
      const pv = mk("span", "tprev"); pv.style.background = t.bg; pv.style.border = "1px solid " + t.bd;
      const pn = mk("span", "tpn"); pn.style.background = t.pn; pn.style.border = "1px solid " + t.bd;
      const l1 = mk("i"); l1.style.cssText = "width:62%;background:" + t.ac;
      const l2 = mk("i"); l2.style.cssText = "width:40%;background:" + t.a2;
      const dots = mk("span", "dots"), d1 = mk("b"), d2 = mk("b"); d1.style.background = t.ac; d2.style.background = t.a2; dots.append(d1, d2);
      pn.append(l1, l2, dots); pv.appendChild(pn);
      const nm = mk("span", "tname"), lab = mk("span", "", t.name), ck = mk("span", "tck", ""); nm.append(lab, ck);
      b.append(pv, nm, mk("span", "tsub", t.sub));
      b.addEventListener("click", () => apply(t.id, true));
      box.appendChild(b); return b;
    });
    function apply(id, save) {
      root.setAttribute("data-theme", id);
      btns.forEach((b) => { const on = b.dataset.id === id; b.setAttribute("aria-checked", String(on)); b.querySelector(".tck").textContent = on ? "✓" : ""; });
      if (save) { try { localStorage.setItem(THEME_KEY, id); } catch (e) {} }
    }
    apply(cur, false);
  })();

  /* ---------- Animations d'apparition (accessibles et progressives) ---------- */
  (function initMotion() {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document.documentElement.classList.add("js-motion");
    const panels = Array.from(document.querySelectorAll("main > .panel, main .steps > .panel, main .grid > .panel, #results > .panel"));
    if (!("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -35px 0px" });
    panels.forEach((panel, index) => {
      panel.classList.add("motion-ready");
      panel.style.transitionDelay = Math.min(index % 3, 2) * 70 + "ms";
      observer.observe(panel);
    });
  })();

  /* ---------- Outils de stats ---------- */
  const fmtDur = (min) => Math.floor(min / 60) + " h " + String(min % 60).padStart(2, "0");
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const median = (a) => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const stdev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))); };
  function pearson(xs, ys) {
    const mx = mean(xs), my = mean(ys); let sxy = 0, sx = 0, sy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sx += (xs[i] - mx) ** 2; sy += (ys[i] - my) ** 2; }
    return sx && sy ? sxy / Math.sqrt(sx * sy) : 0;
  }
  // Regroupe des éléments par clé : Map clé -> {n, min, sum (notes), nr (films notés)}
  function group(items, keysOf) {
    const m = new Map();
    items.forEach((it) => {
      Array.from(new Set(keysOf(it))).forEach((k) => {
        if (!k) return;
        const g = m.get(k) || { k: k, n: 0, min: 0, sum: 0, nr: 0, items: [] };
        g.n++; g.min += it.rt || 0; g.items.push(it);
        if (it.r != null) { g.sum += it.r; g.nr++; }
        m.set(k, g);
      });
    });
    return Array.from(m.values());
  }
  const byCount = (a, b) => b.n - a.n || b.min - a.min || String(a.k).localeCompare(String(b.k));
  const nameOf = (k) => people[k] || String(k);
  const byCountP = (a, b) => b.n - a.n || b.min - a.min || nameOf(a.k).localeCompare(nameOf(b.k));
  const named = (gs) => { gs.forEach((g) => { g.label = nameOf(g.k); }); return gs; };

  const IMG = "https://image.tmdb.org/t/p/";
  const apiKey = () => $("key").value.trim();
  let personCache = {};
  try { personCache = JSON.parse(localStorage.getItem("lb-person-v1") || "{}"); } catch (e) {}
  function personInfo(id) {
    if (personCache[id]) return Promise.resolve(personCache[id]);
    return tmdb("person/" + id, { language: "fr-FR" }, apiKey()).then((d) => {
      const p = { img: d.profile_path || "", b: d.birthday || "", d: d.deathday || "", g: d.gender || 0 };
      personCache[id] = p;
      try { localStorage.setItem("lb-person-v1", JSON.stringify(personCache)); } catch (e) {}
      return p;
    });
  }
  const isDate = (t) => /^\d{4}-\d{2}-\d{2}$/.test(t);
  const fmtDate = (t) => isDate(t) ? new Date(t + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : t;
  function ageAt(birth, end) {
    const b = new Date(birth + "T12:00:00"), e = end ? new Date(end + "T12:00:00") : new Date();
    let a = e.getFullYear() - b.getFullYear();
    if (e.getMonth() < b.getMonth() || (e.getMonth() === b.getMonth() && e.getDate() < b.getDate())) a--;
    return a;
  }
  // Fiche de la personne : photo, naissance, âge ou décès
  function personBox(id, name) {
    const box = document.createElement("div"); box.className = "person";
    const ph = document.createElement("span"); ph.className = "ph"; box.appendChild(ph);
    const tx = document.createElement("div"); tx.className = "pinfo";
    const nm = document.createElement("b"); nm.textContent = name; tx.appendChild(nm);
    box.appendChild(tx);
    personInfo(id).then((p) => {
      if (p.img) {
        const im = document.createElement("img");
        im.src = IMG + "w185" + p.img; im.alt = ""; im.width = 64; im.height = 96;
        box.replaceChild(im, ph);
      }
      const line = (t) => { const s = document.createElement("span"); s.textContent = t; tx.appendChild(s); };
      const born = p.g === 1 ? "Née" : p.g === 2 ? "Né" : "Né(e)";
      const died = p.g === 1 ? "Morte" : p.g === 2 ? "Mort" : "Mort(e)";
      if (p.b) {
        line(born + " le " + fmtDate(p.b) + (!p.d && isDate(p.b) ? " · " + ageAt(p.b) + " ans" : ""));
        if (p.d) line(died + " le " + fmtDate(p.d) + (isDate(p.b) && isDate(p.d) ? " · à " + ageAt(p.b, p.d) + " ans" : ""));
      } else if (p.d) line(died + " le " + fmtDate(p.d));
      else line("Date de naissance non renseignée");
    }).catch(() => {});
    return box;
  }

  function filmsList(items, o) {
    const box = document.createElement("div"); box.className = "films";
    // o.sort "pop" : les plus populaires d'abord (nombre de votes TMDB) ; sinon les mieux notés par toi d'abord
    let list = o.sort === "none" ? items.slice() : items.slice().sort(o.sort === "pop"
      ? (a, b) => b.n - a.n || b.v - a.v || a.year - b.year
      : (a, b) => (b.r == null ? -1 : b.r) - (a.r == null ? -1 : a.r) || b.v - a.v || a.year - b.year);
    if (o.limit) list = list.slice(0, o.limit);
    list.forEach((m) => {
      const row = document.createElement("div"); row.className = "film";
      if (m.p) {
        const im = document.createElement("img");
        im.src = IMG + "w92" + m.p; im.alt = ""; im.width = 46; im.height = 69; im.loading = "lazy";
        row.appendChild(im);
      } else { const ph = document.createElement("span"); ph.className = "ph"; row.appendChild(ph); }
      const tx = document.createElement("div");
      const nm = document.createElement("b"); nm.textContent = m.name;
      const sub = document.createElement("span");
      const role = o.roleOf ? o.roleOf(m) : "";
      sub.textContent = m.year + (m.r != null ? " · ta note " + nf1(m.r) + " ★" : "") + (role ? " · " + role : "");
      tx.append(nm, sub); row.appendChild(tx); box.appendChild(row);
      clickable(row, m);
    });
    return box;
  }

  // Menu déroulant d'une ligne : fiche + tous ses films (réalisateurs, acteurs) ou ses 5 films les mieux notés (autres classements)
  // Complète au besoin l'entrée du cache (identifiant, date de sortie, 3 premiers rôles) pour les films déjà calculés
  function detailsFor(item) {
    if (item.i) return Promise.resolve(item);
    const k = item.name + "|" + item.year;
    return lookup({ name: item.name, year: String(item.year) }, apiKey()).then((res) => {
      if (res.ok) { Object.assign(item, res); if (cache[k]) Object.assign(cache[k], res); saveCache(); }
      return item;
    });
  }
  // Fiche d'un film : affiche, date, ta note, note moyenne TMDB, réalisateur, 3 acteurs majeurs
  /* ---------- Fenêtre d'un film (clic sur n'importe quel titre) ---------- */
  const modal = $("modal");
  let lastFocus = null;
  function openFilm(item) {
    lastFocus = document.activeElement;
    $("modalBody").textContent = "";
    $("modalBody").appendChild(filmCard(item, true));
    modal.hidden = false;
    $("modalClose").focus();
  }
  function closeFilm() {
    modal.hidden = true; $("modalBody").textContent = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $("modalClose").addEventListener("click", closeFilm);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeFilm(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeFilm(); });
  // Rend un élément cliquable (souris et clavier) pour ouvrir la fiche d'un film
  function clickable(el, item) {
    el.classList.add("clickable"); el.tabIndex = 0; el.setAttribute("role", "button");
    el.addEventListener("click", () => openFilm(item));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFilm(item); } });
  }

  function filmCard(item, big) {
    const box = document.createElement("div"); box.className = "filmcard";
    const ph = document.createElement("span"); ph.className = "ph"; box.appendChild(ph);
    const tx = document.createElement("div"); tx.className = "pinfo"; box.appendChild(tx);
    const fill = () => {
      if (item.p && !box.querySelector("img")) {
        const im = document.createElement("img");
        im.src = IMG + (big ? "w342" : "w185") + item.p; im.alt = ""; im.width = big ? 150 : 92; im.height = big ? 225 : 138;
        box.replaceChild(im, ph);
      }
      tx.textContent = "";
      const nm = document.createElement("b"); nm.textContent = item.name; tx.appendChild(nm);
      const line = (t) => { const s = document.createElement("span"); s.textContent = t; tx.appendChild(s); };
      line(isDate(item.rd) ? "Sorti le " + fmtDate(item.rd) : "Sorti en " + item.year);
      line("Ta note : " + (item.r != null ? nf1(item.r) + " ★" : "non notée") + " · Note moyenne TMDB : " + (item.v ? nf1(item.v / 2) + " / 5" : "non disponible"));
      line("Réalisé par " + (item.d && item.d.length ? item.d.map(nameOf).join(", ") : "réalisateur inconnu"));
      if (item.t && item.t.length) line("Avec " + item.t.map(nameOf).join(", "));
      if (big) {
        const bits = [];
        if (item.rt) bits.push(fmtDur(item.rt));
        if (item.g && item.g.length) bits.push(item.g.join(", "));
        if (bits.length) line(bits.join(" · "));
        const where = (item.c || []).map((c) => safeName(regionNames, c)).join(", ");
        const lang = item.l ? "langue originale : " + safeName(langNames, item.l) : "";
        if (where || lang) line([where, lang].filter(Boolean).join(" · "));
      }
    };
    fill();
    detailsFor(item).then(fill).catch(() => {});
    return box;
  }

  function dropBox(r) {
    const box = document.createElement("div"); box.className = "dropbox"; box.hidden = true;
    if (r.film) { box.appendChild(filmCard(r.film)); return box; }
    if (r.person) box.appendChild(personBox(r.person, r.label));
    else {
      const cap = document.createElement("p"); cap.className = "cap";
      cap.textContent = r.full ? "Les films de cette saga que tu as vus"
        : r.items.some((m) => m.r != null) ? "Tes 5 films les mieux notés" : "Les 5 films les mieux notés par TMDB";
      box.appendChild(cap);
    }
    box.appendChild(filmsList(r.items, { limit: r.person || r.full ? 0 : 5, roleOf: r.roleOf }));
    if (r.missing && r.missing.length) {
      const ms = document.createElement("p"); ms.className = "hint";
      ms.textContent = "Il te manque : " + r.missing.join(", ") + ".";
      box.appendChild(ms);
    }
    return box;
  }

  function rank(id, rows, maxVal, empty) {
    const ol = $(id); ol.textContent = "";
    if (!rows.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = empty || "Pas assez de données."; ol.appendChild(li); return; }
    rows.forEach((r) => {
      const li = document.createElement("li");
      let l;
      if (r.pick) {
        l = document.createElement("button"); l.type = "button"; l.className = "lbl rowbtn";
        l.append(document.createTextNode(r.label));
        const caret = document.createElement("span"); caret.className = "caret"; caret.setAttribute("aria-hidden", "true"); caret.textContent = "›";
        const hint = document.createElement("span"); hint.className = "showhint"; hint.textContent = "Afficher les films";
        l.append(caret, hint);
        l.addEventListener("click", r.pick);
      } else if ((r.items && r.items.length) || r.film) {
        const what = r.film ? "le film" : "les films";
        l = document.createElement("button"); l.type = "button"; l.className = "lbl rowbtn"; l.setAttribute("aria-expanded", "false");
        l.append(document.createTextNode(r.label));
        const caret = document.createElement("span"); caret.className = "caret"; caret.setAttribute("aria-hidden", "true"); caret.textContent = "▾";
        const hint = document.createElement("span"); hint.className = "showhint"; hint.textContent = "Afficher " + what;
        l.append(caret, hint);
        let box = null;
        l.addEventListener("click", () => {
          if (!box) { box = dropBox(r); li.appendChild(box); }
          const open = box.hidden;
          box.hidden = !open;
          l.setAttribute("aria-expanded", String(open));
          li.classList.toggle("open", open);
          hint.textContent = (open ? "Masquer " : "Afficher ") + what;
        });
      } else { l = document.createElement("span"); l.className = "lbl"; l.textContent = r.label; }
      const v = document.createElement("span"); v.className = "val"; v.textContent = r.value;
      const t = document.createElement("span"); t.className = "track";
      const i = document.createElement("i"); i.style.width = Math.max(2, r.frac * 100) + "%"; t.appendChild(i);
      li.append(l, v, t); ol.appendChild(li);
    });
  }
  // o.tips : "top" (5 meilleurs films) ou "people" (fiche + tous les films) ; o.roleOf(film, id) : mention du rôle
  const countRows = (groups, o) => {
    o = o || {};
    const max = groups.length ? groups[0].n : 1;
    return groups.map((g) => ({
      label: g.label || g.k,
      items: o.tips ? g.items : null,
      person: o.tips === "people" ? g.k : 0,
      roleOf: o.roleOf ? (m) => o.roleOf(m, g.k) : null,
      value: g.n + (g.n > 1 ? " films" : " film") + (o.hours ? " · " + Math.round(g.min / 60) + " h" : ""),
      frac: g.n / max
    }));
  };

  /* ---------- Carte du monde ---------- */
  const SIGNS = ["", "▰▱▱▱", "▰▰▱▱", "▰▰▰▱", "▰▰▰▰"];
  const LEVELS = ["Aucun film", "Très peu de films", "Quelques films", "Pas mal de films", "Beaucoup de films"];
  const mapTip = document.createElement("div");
  mapTip.id = "maptip"; mapTip.hidden = true; mapTip.setAttribute("role", "tooltip");
  document.body.appendChild(mapTip);

  function renderMap(ctry, total, cname) {
    const M = window.WORLD_MAP, panel = $("mapPanel");
    if (!M || !ctry.length) { panel.hidden = true; return; }
    panel.hidden = false;
    const byCode = new Map(); ctry.forEach((g) => byCode.set(g.k, g));
    // Niveaux selon la part du total de films de la personne : jusqu'à 2 % très peu, 5 % quelques films, 15 % pas mal, au-delà beaucoup
    const t1 = Math.max(1, Math.floor(total * 0.02)), t2 = Math.floor(total * 0.05), t3 = Math.floor(total * 0.15);
    const level = (n) => n <= 0 ? 0 : n <= t1 ? 1 : n <= t2 ? 2 : n <= t3 ? 3 : 4;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + M.w + " " + M.h);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Carte du monde des films vus, par pays de production");
    Object.keys(M.paths).forEach((code) => {
      const p = document.createElementNS(NS, "path");
      const g = byCode.get(code);
      p.setAttribute("d", M.paths[code]);
      p.setAttribute("class", "country lv" + (g ? level(g.n) : 0));
      p.setAttribute("data-code", code);
      svg.appendChild(p);
    });
    const mapEl = $("map"); mapEl.textContent = ""; mapEl.appendChild(svg);

    const info = (code) => {
      const g = byCode.get(code), n = g ? g.n : 0, lv = level(n);
      return { name: cname(code), n: n, lv: lv, text: n === 0 ? "Aucun film vu" : n + (n > 1 ? " films" : " film") + " · " + SIGNS[lv] + " " + LEVELS[lv] };
    };
    const place = (e) => {
      const w = mapTip.offsetWidth, h = mapTip.offsetHeight;
      mapTip.style.left = Math.max(8, Math.min(e.clientX + 14, window.innerWidth - w - 8)) + "px";
      mapTip.style.top = Math.max(8, Math.min(e.clientY + 14, window.innerHeight - h - 8)) + "px";
    };
    const codeOf = (e) => (e.target.getAttribute && e.target.getAttribute("data-code")) || "";
    svg.addEventListener("mousemove", (e) => {
      const code = codeOf(e);
      if (!code) { mapTip.hidden = true; return; }
      const f = info(code);
      mapTip.textContent = "";
      const b = document.createElement("b"); b.textContent = f.name;
      const sp = document.createElement("span"); sp.textContent = f.text;
      mapTip.append(b, sp); mapTip.hidden = false; place(e);
    });
    svg.addEventListener("mouseleave", () => { mapTip.hidden = true; });

    // Panneau à droite : classement des pays, ou les 10 films les plus populaires du pays cliqué
    const side = $("mapSide");
    const unselect = () => { svg.querySelectorAll(".sel").forEach((p) => p.classList.remove("sel")); };
    const title = (txt) => { const h = document.createElement("h3"); h.textContent = txt; return h; };
    function showTop() {
      unselect();
      side.textContent = "";
      const ol = document.createElement("ol"); ol.className = "rank"; ol.id = "countries";
      const hint = document.createElement("p"); hint.className = "hint"; hint.textContent = "Clique sur un pays, ici ou sur la carte, pour voir ses films les plus populaires.";
      side.append(title("Top 10 des pays"), ol, hint);
      const rows = countRows(ctry.slice(0, 10));
      rows.forEach((r, i) => { r.pick = () => select(ctry[i].k); });
      rank("countries", rows);
    }
    function select(code) {
      const f = info(code), g = byCode.get(code);
      unselect();
      const path = svg.querySelector('[data-code="' + code + '"]');
      if (path) { path.classList.add("sel"); svg.appendChild(path); }
      side.textContent = "";
      const back = document.createElement("button"); back.type = "button"; back.className = "ghost small"; back.textContent = "‹ Top 10 des pays";
      back.addEventListener("click", showTop);
      const sub = document.createElement("p"); sub.className = "sub"; sub.textContent = f.text;
      side.append(back, title(f.name), sub);
      if (g) {
        const cap = document.createElement("p"); cap.className = "cap";
        cap.textContent = "Tes " + Math.min(10, g.items.length) + " films les plus populaires de ce pays";
        side.append(cap, filmsList(g.items, { limit: 10, sort: "pop" }));
      }
    }
    svg.addEventListener("click", (e) => { const code = codeOf(e); if (code) select(code); });
    showTop();

    // Légende : couleur et signe de chaque niveau
    const lg = $("mapLegend"); lg.textContent = "";
    for (let l = 0; l <= 4; l++) {
      const li = document.createElement("li");
      const sw = document.createElement("span"); sw.className = "sw lv" + l;
      const tx = document.createElement("span"); tx.textContent = (SIGNS[l] ? SIGNS[l] + " " : "") + LEVELS[l];
      li.append(sw, tx); lg.appendChild(li);
    }
    // Pays qui n'existent plus ou ne sont pas dessinés
    const other = ctry.filter((g) => !M.paths[g.k]);
    const oe = $("mapOther");
    oe.hidden = !other.length;
    if (other.length) oe.textContent = "Hors carte : " + other.map((g) => cname(g.k) + " (" + g.n + ")").join(", ") + ".";
  }

  /* ---------- Affichage ---------- */
  const roleOf = (m, id) => (m.m.concat(m.f, m.u).indexOf(id) >= 0 ? "rôle majeur" : "second rôle");
  const castOf = (x) => [].concat(x.m || [], x.f || [], x.u || [], x.o || []);

  function render() {
    const withRe = $("rewatch").checked && rewatches.length;
    const all = [], missing = [];
    films.forEach((f) => {
      const c = cache[keyOf(f)];
      if (c && c.ok) all.push(Object.assign({ name: f.name, year: parseInt(f.year, 10), uri: (f.uri || "").replace(/\/$/, ""), r: ratings && ratings.has(keyOf(f)) ? ratings.get(keyOf(f)) : null, liked: likes ? likes.has(keyOf(f)) : false }, c));
      else missing.push(f);
    });
    const timed = all.filter((x) => x.rt > 0);
    const totalMin = timed.reduce((s, x) => s + x.rt, 0);
    let reMin = 0;
    if (withRe) rewatches.forEach((f) => { const c = cache[keyOf(f)]; reMin += (c && c.rt) || 0; });
    const grand = totalMin + reMin;
    const longest = timed.slice().sort((a, b) => b.rt - a.rt);

    // Bloc principal
    $("rH").textContent = nf.format(Math.round(grand / 60));
    $("rSub").textContent = fmtDur(grand) + " au total, soit " + nf1(grand / 1440) + " jours sans dormir"
      + (withRe ? " (dont " + fmtDur(reMin) + " de revisionnages)" : "") + ".";
    $("rCount").textContent = nf.format(all.length) + " / " + nf.format(films.length);
    $("rAvg").textContent = timed.length ? fmtDur(Math.round(totalMin / timed.length)) : "-";
    $("rLong").textContent = longest.length ? longest[0].name + " (" + fmtDur(longest[0].rt) + ")" : "-";
    const sh = longest[longest.length - 1];
    $("rShort").textContent = sh ? sh.name + " (" + sh.rt + " min)" : "-";
    $("stLikes").hidden = !likes; if (likes) $("rLikes").textContent = nf.format(likes.size);
    $("stRe").hidden = !rewatches.length; if (rewatches.length) $("rRe").textContent = nf.format(rewatches.length);

    // Plus longs
    const body = $("topBody"); body.textContent = "";
    longest.slice(0, 10).forEach((m) => {
      const tr = document.createElement("tr");
      clickable(tr, m);
      [[m.name, ""], [m.year, "n"], [fmtDur(m.rt), "n"]].forEach((c) => {
        const td = document.createElement("td"); td.textContent = c[0]; if (c[1]) td.className = "n"; tr.appendChild(td);
      });
      body.appendChild(tr);
    });

    // Classements
    const genres = group(all, (x) => x.g).sort(byCount);
    rank("genres", countRows(genres.slice(0, 10), { hours: true, tips: "top" }));
    const years = group(all, (x) => [x.year]).sort(byCount);
    rank("years", countRows(years.slice(0, 10), { tips: "top" }));
    const decs = group(all, (x) => [Math.floor(x.year / 10) * 10]).sort((a, b) => a.k - b.k);
    const dmax = Math.max.apply(null, decs.map((d) => d.n).concat([1]));
    rank("decades", decs.map((d) => ({ label: d.k + "s", items: d.items, value: d.n + " · " + Math.round(d.n / all.length * 100) + " %", frac: d.n / dmax })));
    const dirs = group(all, (x) => x.d).sort(byCountP);
    rank("directors", countRows(named(dirs.slice(0, 10)), { tips: "people" }));
    const men = group(all, (x) => x.m || []).sort(byCountP);
    rank("actorsM", countRows(named(men.slice(0, 10)), { tips: "people" }));
    const women = group(all, (x) => x.f || []).sort(byCountP);
    rank("actorsF", countRows(named(women.slice(0, 10)), { tips: "people" }));
    const everyone = group(all, castOf).sort(byCountP);
    rank("actorsAll", countRows(named(everyone.slice(0, 10)), { tips: "people", roleOf: roleOf }));
    // Les films de l'URSS sont comptés avec la Russie
    const ussr = all.some((x) => (x.c || []).indexOf("SU") >= 0);
    const ctry = group(all, (x) => (x.c || []).map((c) => (c === "SU" ? "RU" : c))).sort(byCount);
    const cname = (code) => (code === "RU" && ussr ? "Russie (et URSS par le passé)" : safeName(regionNames, code));
    ctry.forEach((c) => { c.label = cname(c.k); });
    const lg = group(all, (x) => [x.l]).sort(byCount);
    lg.forEach((c) => { c.label = safeName(langNames, c.k); });
    rank("langs", countRows(lg.slice(0, 10), { tips: "top" }));
    renderMap(ctry, all.length, cname);

    renderRatings(all, genres);
    renderFavs(all);
    renderCollections(all);

    // Plus revus : films revus au moins 2 fois, avec la date de chaque revisionnage (diary.csv)
    const byKey = new Map(); all.forEach((x) => byKey.set(x.name + "|" + x.year, x));
    const reDates = new Map();
    rewatches.forEach((f) => { const k = keyOf(f); if (!reDates.has(k)) reDates.set(k, []); reDates.get(k).push(f.date); });
    const reRows = Array.from(reDates.entries()).filter((e) => e[1].length >= 2)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 10);
    $("rePanel").hidden = !reRows.length;
    if (reRows.length) renderReTop(reRows, byKey);

    renderYear(byKey);
    renderWatchlist();
    renderTags(byKey);
    renderExplorer(all);
    renderDuelPanel();

    // Non trouvés
    const ul = $("missList"); ul.textContent = "";
    missing.forEach((f) => ul.appendChild(missItem(f)));
    lastMissing = missing;
    $("missN").textContent = missing.length;
    $("missPanel").hidden = !missing.length;

    $("results").hidden = false;
    if (!keepScroll) $("results").scrollIntoView({ behavior: "smooth", block: "start" });
    keepScroll = false;
  }


  /* ---------- Films les plus revus : une ligne par film, avec chaque date ---------- */
  function renderReTop(rows, byKey) {
    const ol = $("reTop"); ol.textContent = "";
    const max = rows[0][1].length;
    rows.forEach((e) => {
      const film = byKey.get(e[0]), n = e[1].length;
      const li = document.createElement("li");
      const l = document.createElement("span"); l.className = "lbl"; l.textContent = film ? film.name + " (" + film.year + ")" : e[0].replace("|", " (") + ")";
      if (film) clickable(l, film);
      const v = document.createElement("span"); v.className = "val"; v.textContent = n + " revisionnages";
      const t = document.createElement("span"); t.className = "track";
      const i = document.createElement("i"); i.style.width = Math.max(2, n / max * 100) + "%"; t.appendChild(i);
      const ch = document.createElement("ul"); ch.className = "chips";
      e[1].slice().sort((a, b) => (isIso(a) ? 0 : 1) - (isIso(b) ? 0 : 1) || String(a).localeCompare(String(b))).forEach((d) => {
        const c = document.createElement("li"); c.textContent = isIso(d) ? longDate(fromIso(d)) : "date inconnue"; ch.appendChild(c);
      });
      li.append(l, v, t, ch); ol.appendChild(li);
    });
  }

  /* ---------- Sagas et franchises (collections TMDB) ---------- */
  let collToken = 0, collCache = {};
  try { collCache = JSON.parse(localStorage.getItem("lb-coll-v1") || "{}"); } catch (e) {}
  function renderCollections(all) {
    const tok = ++collToken, panel = $("collPanel");
    const by = new Map();
    all.forEach((x) => { if (x.col) { if (!by.has(x.col)) by.set(x.col, []); by.get(x.col).push(x); } });
    const ids = Array.from(by.keys()).filter((id) => by.get(id).length >= 2);
    panel.hidden = !ids.length;
    if (!ids.length) return;
    rank("coll", [], 0, "Chargement des sagas…"); $("coll2").textContent = "";
    $("collNote").textContent = "";
    const todo = ids.filter((id) => !collCache[id]), key = apiKey();
    let next = 0;
    const one = (id) => tmdb("collection/" + id, { language: "fr-FR" }, key).then((d) => {
      collCache[id] = { n: d.name || "", p: (d.parts || []).map((p) => [p.id, p.release_date || "", p.title || ""]) };
    }).catch(() => {});
    const worker = () => (next >= todo.length || tok !== collToken) ? Promise.resolve() : one(todo[next++]).then(worker);
    Promise.all([1, 2, 3, 4].map(worker)).then(() => {
      if (tok !== collToken) return;
      try { localStorage.setItem("lb-coll-v1", JSON.stringify(collCache)); } catch (e) {}
      const today = isoOf(new Date());
      const rows = ids.filter((id) => collCache[id]).map((id) => {
        const items = by.get(id), c = collCache[id], mine = new Set(items.map((x) => x.i));
        const parts = c.p.filter((p) => p[1] && p[1] <= today);
        const total = Math.max(parts.length, 1), seen = Math.min(parts.filter((p) => mine.has(p[0])).length, total);
        const missing = parts.filter((p) => !mine.has(p[0])).sort((a, b) => a[1].localeCompare(b[1])).map((p) => p[2]);
        return { id: id, label: c.n || items[0].cn || "Saga", items: items, seen: seen, total: total, missing: missing, done: seen >= total };
      }).filter((r) => r.total >= 2)
        .sort((a, b) => b.seen - a.seen || b.seen / b.total - a.seen / a.total || b.total - a.total || a.label.localeCompare(b.label))
        .slice(0, 30);
      const nDone = rows.filter((r) => r.done).length;
      $("collNote").textContent = rows.length ? rows.length + " sagas affichées, dont " + nDone + (nDone > 1 ? " complètes." : " complète.") : "";
      const cr = rows.map((r) => ({
        label: r.label, items: r.items, full: true, missing: r.missing,
        value: r.seen + " / " + r.total + " films" + (r.done ? " · complète ✓" : ""), frac: r.seen / r.total
      }));
      rank("coll", cr.slice(0, 15), 0, "Impossible de charger les sagas pour le moment.");   // les 15 premières à gauche
      if (cr.length > 15) rank("coll2", cr.slice(15)); else $("coll2").textContent = "";     // les 15 suivantes à droite
    });
  }

  // Top 4 de la personne : liens du profil retrouvés dans la liste des films vus (même lien Letterboxd), affiches TMDB
  function posterFig(x, extra) {
    const fg = document.createElement("figure");
    clickable(fg, x);
    if (x.p) {
      const im = document.createElement("img");
      im.src = IMG + "w342" + x.p; im.alt = "Affiche de " + x.name; im.loading = "lazy";
      fg.appendChild(im);
    } else { const ph = document.createElement("span"); ph.className = "ph"; fg.appendChild(ph); }
    const cp = document.createElement("figcaption");
    const nm = document.createElement("b"); nm.textContent = x.name;
    const yr = document.createElement("span"); yr.textContent = x.year;
    cp.append(nm, yr);
    if (extra) { const ex = document.createElement("span"); ex.textContent = extra; cp.appendChild(ex); }
    fg.appendChild(cp);
    return fg;
  }
  function renderFavs(all) {
    const byUri = new Map(), byK = new Map();
    all.forEach((x) => { if (x.uri) byUri.set(x.uri, x); byK.set(x.name + "|" + x.year, x); });
    const items = favorites.map((u) => byUri.get(u)).filter(Boolean);
    // Dernier film liké : date de coup de cœur la plus récente (à égalité, le plus bas dans likes.csv)
    let last = null;
    likeDates.forEach((e) => { const x = byK.get(e.k); if (x && (!last || e.d >= last.d)) last = { x: x, d: e.d }; });
    const list = $("favList"), ll = $("lastLikeList");
    list.textContent = ""; ll.textContent = "";
    $("favTop").hidden = !items.length;
    $("favLike").hidden = !last;
    $("favs").hidden = !items.length && !last;
    if ($("favs").hidden) return;
    $("profilePanel").hidden = false;
    items.forEach((x) => list.appendChild(posterFig(x)));
    if (last) ll.appendChild(posterFig(last.x, isIso(last.d) ? "liké le " + longDate(fromIso(last.d)) : ""));
  }

  const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const nf2 = (x) => x.toFixed(2).replace(".", ",");
  const isIso = (t) => /^\d{4}-\d{2}-\d{2}$/.test(t || "");
  const isoOf = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const longDate = (d) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const fromIso = (t) => { const p = t.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  let yearChoice = null, lastByKey = null;

  // Séances d'une année civile : uniquement les entrées du journal (diary.csv), à leur date de visionnage (colonne « Watched Date »).
  // Du 1er janvier à aujourd'hui pour l'année en cours, jusqu'au 31 décembre pour les années passées.
  function renderYear(byKey) {
    lastByKey = byKey;
    const now = new Date(), cur = now.getFullYear();
    const raw = diaryRows.filter((r) => isIso(r.date));
    const panel = $("yearPanel");
    $("yearMiss").hidden = true;
    if (!raw.length) { panel.hidden = true; return; }
    panel.hidden = false;

    // Années proposées : celles où au moins un film figure au journal, plus l'année en cours (affichée par défaut)
    const years = Array.from(new Set(raw.map((x) => +x.date.slice(0, 4)).concat([cur]))).sort((a, b) => b - a);
    const Y = years.indexOf(yearChoice) >= 0 ? yearChoice : cur;
    const sel = $("yearSel"); sel.textContent = "";
    years.forEach((y) => { const o = document.createElement("option"); o.value = y; o.textContent = y === cur ? y + " (en cours)" : String(y); sel.appendChild(o); });
    sel.value = String(Y);
    $("yearN").textContent = Y;

    const start = new Date(Y, 0, 1), end = Y === cur ? new Date(cur, now.getMonth(), now.getDate()) : new Date(Y, 11, 31);
    const days = Math.round((end - start) / 864e5) + 1, endIso = isoOf(end);
    const when = "Du 1er janvier au " + longDate(end) + " (" + days + " jours)";
    const sessions = raw.filter((x) => x.date.startsWith(Y + "-") && x.date <= endIso);
    if (!sessions.length) {
      $("yearSum").textContent = when + " : aucune séance dans ton journal.";
      $("weekdays").textContent = "Rien à afficher pour cette année.";
      $("yearExtra").hidden = true; $("dayBox").textContent = "";
      $("yearNote").textContent = "";
      return;
    }

    let min = 0;
    const unknownList = [];
    const per = [0, 0, 0, 0, 0, 0, 0], items = [[], [], [], [], [], [], []];
    sessions.forEach((x) => {
      const it = byKey.get(x.name + "|" + x.year);
      if (it && it.rt) min += it.rt; else unknownList.push({ x: x, found: !!it });
      const d = fromIso(x.date).getDay();
      per[d]++;
      if (it) items[d].push(it);
    });
    // Nombre de chaque jour de la semaine sur la période
    const occ = [0, 0, 0, 0, 0, 0, 0];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) occ[d.getDay()]++;
    // Jours distincts avec au moins un film, par jour de la semaine
    const on = [0, 0, 0, 0, 0, 0, 0];
    Array.from(new Set(sessions.map((x) => x.date))).forEach((iso) => { on[fromIso(iso).getDay()]++; });
    const rows = DAYS.map((name, d) => ({ d: d, name: name, n: per[d], pct: Math.min(1, on[d] / Math.max(1, occ[d])), items: items[d] }));
    const top = rows.slice().sort((a, b) => b.pct - a.pct || b.n - a.n)[0];
    $("yearSum").textContent = when + " : " + sessions.length + (sessions.length > 1 ? " films vus" : " film vu")
      + " (revisionnages compris), soit " + fmtDur(min) + " de cinéma. Ton jour favori : le " + top.name + ", avec " + top.n + (top.n > 1 ? " films" : " film") + ".";
    renderCalendar(sessions, byKey, Y, end, rows, top.d);
    $("yearNote").textContent = "";
    $("yearExtra").hidden = false;
    renderYearExtras(sessions, byKey, Y, endIso, Y === cur);
    // Séances sans durée : listées dans un menu déroulant, uniquement s'il y en a
    const ym = $("yearMiss"), yl = $("yearMissList"); yl.textContent = "";
    ym.hidden = !unknownList.length;
    if (unknownList.length) {
      $("yearMissN").textContent = unknownList.length + (unknownList.length > 1 ? " séances sans durée, non comptées dans les heures" : " séance sans durée, non comptée dans les heures");
      unknownList.forEach((u) => {
        const li = document.createElement("li");
        li.textContent = u.x.name + " (" + u.x.year + ") · vu le " + longDate(fromIso(u.x.date)) + (u.found ? " · durée absente sur TMDB" : " · film non trouvé sur TMDB");
        yl.appendChild(li);
      });
    }
  }

  const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const MONTHS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const dayNum = (iso) => { const p = iso.split("-").map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5); };
  const fmtDay = (n) => new Date(n * 864e5).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });
  const fmtDayY = (n) => new Date(n * 864e5).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const span = (a, b) => (a === b ? "le " + fmtDayY(a) : "du " + fmtDay(a) + " au " + fmtDayY(b));

  // Évolution mois par mois (nombre de films et note moyenne) et séries de visionnage, d'après la colonne « Watched Date » du journal
  function renderYearExtras(sessions, byKey, Y, endIso, isCur) {
    const cnt = Array(12).fill(0), sum = Array(12).fill(0), nr = Array(12).fill(0);
    sessions.forEach((x) => {
      const m = +x.date.slice(5, 7) - 1, it = byKey.get(x.name + "|" + x.year);
      cnt[m]++;
      if (it && it.r != null) { sum[m] += it.r; nr[m]++; }
    });
    const avgs = sum.map((s, m) => (nr[m] ? s / nr[m] : null));
    let best = -1;
    avgs.forEach((a, m) => { if (a != null && (best < 0 || a > avgs[best] || (a === avgs[best] && nr[m] > nr[best]))) best = m; });
    drawCombo({
      box: "monthChart", labels: MONTHS, counts: cnt, avgs: avgs, best: best, xTitle: "Mois de " + Y,
      aria: "Nombre de films et note moyenne par mois en " + Y,
      tipBar: (m) => MONTHS_LONG[m] + " : " + plural(cnt[m], "film"),
      tipDot: (m) => MONTHS_LONG[m] + " : " + nf1(avgs[m]) + " ★ de moyenne sur " + plural(nr[m], "film") + " noté"
    });
    const order = avgs.map((a, m) => m).filter((m) => avgs[m] != null).sort((a, b) => avgs[b] - avgs[a] || nr[b] - nr[a]).slice(0, 3);
    $("monthNote").textContent = "Barres : films vus dans le mois (axe de droite). Courbe : note moyenne du mois (axe de gauche)."
      + (order.length ? " Mois les mieux notés : " + order.map((m) => MONTHS_LONG[m] + " (" + nf1(avgs[m]) + " ★)").join(", ") + "." : " Pas de notes pour cette année.");

    // Séries de visionnage
    const perDay = new Map();
    sessions.forEach((x) => { const d = dayNum(x.date); perDay.set(d, (perDay.get(d) || 0) + 1); });
    const days = Array.from(perDay.keys()).sort((a, b) => a - b);
    let sBest = [1, days[0], days[0]], run = 1, runStart = days[0], gBest = null;
    for (let i = 1; i < days.length; i++) {
      if (days[i] === days[i - 1] + 1) { run++; } else {
        const gap = days[i] - days[i - 1] - 1;
        if (!gBest || gap > gBest[0]) gBest = [gap, days[i - 1] + 1, days[i] - 1];
        run = 1; runStart = days[i];
      }
      if (run > sBest[0]) sBest = [run, runStart, days[i]];
    }
    let dBest = days[0];
    days.forEach((d) => { if (perDay.get(d) > perDay.get(dBest)) dBest = d; });
    const perWeek = new Map();
    days.forEach((d) => { const w = d - ((d + 3) % 7); perWeek.set(w, (perWeek.get(w) || 0) + perDay.get(d)); });
    let wBest = null;
    perWeek.forEach((c, w) => { if (!wBest || c > wBest[0] || (c === wBest[0] && w < wBest[1])) wBest = [c, w]; });
    const wEnd = wBest[1] + 6, sd = new Date(wBest[1] * 864e5), ed = new Date(wEnd * 864e5);
    const weekTxt = "du " + (sd.getUTCMonth() === ed.getUTCMonth() ? sd.getUTCDate() : fmtDay(wBest[1])) + " au " + fmtDayY(wEnd);
    let mBest = 0; cnt.forEach((c, m) => { if (c > cnt[mBest]) mBest = m; });
    const live = isCur && sBest[2] === dayNum(endIso);
    const stats = [
      ["Plus longue série", plural(sBest[0], "jour") + " d'affilée", span(sBest[1], sBest[2]) + (live ? " (en cours)" : "")],
      ["Plus long creux", gBest ? plural(gBest[0], "jour") + " sans film" : "-", gBest ? span(gBest[1], gBest[2]) : "Aucun jour sans film entre deux séances."],
      ["Jour le plus chargé", plural(perDay.get(dBest), "film"), "le " + fmtDayY(dBest)],
      ["Semaine la plus chargée", plural(wBest[0], "film"), weekTxt + " (du lundi au dimanche)"],
      ["Mois le plus chargé", plural(cnt[mBest], "film"), MONTHS_LONG[mBest] + " " + Y]
    ];
    const box = $("streaks"); box.textContent = "";
    stats.forEach((t) => {
      const d = document.createElement("div"); d.className = "stat";
      const a = document.createElement("span"); a.textContent = t[0];
      const b = document.createElement("b"); b.textContent = t[1];
      const c = document.createElement("em"); c.textContent = t[2];
      d.append(a, b, c); box.appendChild(d);
    });
  }
  /* ---------- Calendrier de l'année : une case par jour, colorée selon le nombre de films (colonne « Watched Date ») ---------- */
  const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
  function renderCalendar(sessions, byKey, Y, end, rows, topD) {
    const box = $("weekdays"); box.textContent = ""; $("dayBox").textContent = "";
    const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const byDate = new Map();
    sessions.forEach((x) => { if (!byDate.has(x.date)) byDate.set(x.date, []); byDate.get(x.date).push(x); });
    const jan1 = new Date(Y, 0, 1), off = (jan1.getDay() + 6) % 7;
    const nDays = Math.round((new Date(Y, 11, 31) - jan1) / 864e5) + 1, weeks = Math.ceil((off + nDays) / 7);
    const grid = mk("div", "calgrid"); grid.style.gridTemplateColumns = "auto repeat(" + weeks + ", minmax(11px, 1fr)) auto";
    const place = (e, r, c, span) => { e.style.gridRow = r; e.style.gridColumn = span ? c + " / span " + span : c; grid.appendChild(e); return e; };
    for (let m = 0; m < 12; m++) {
      const w = Math.floor((off + Math.round((new Date(Y, m, 1) - jan1) / 864e5)) / 7);
      place(mk("span", "calmonth", MONTHS[m]), 1, w + 2, 3);
    }
    WD_ORDER.forEach((d, r) => {
      const row = rows[d];
      place(mk("span", "callab", DAYS[d].charAt(0).toUpperCase() + DAYS[d].slice(1)), r + 2, 1);
      place(mk("span", "calval" + (d === topD ? " top" : ""), Math.round(row.pct * 100) + " % des " + row.name + "s · " + row.n + (row.n > 1 ? " films" : " film")), r + 2, weeks + 2);
    });
    let selected = null;
    for (let i = 0; i < nDays; i++) {
      const dt = new Date(Y, 0, 1 + i), iso = isoOf(dt), list = byDate.get(iso) || [], n = list.length;
      const cell = mk("span", "day" + (n ? " on" : "") + (dt > end ? " fut" : ""));
      const when = DAYS[dt.getDay()] + " " + longDate(dt);
      cell.title = when + " : " + (n ? plural(n, "film") : "aucun film");
      if (n) {
        cell.tabIndex = 0; cell.setAttribute("role", "button"); cell.setAttribute("aria-label", cell.title);
        const show = () => {
          if (selected) selected.classList.remove("sel");
          selected = cell; cell.classList.add("sel");
          const out = $("dayBox"); out.textContent = "";
          out.appendChild(mk("h3", "", when.charAt(0).toUpperCase() + when.slice(1) + " : " + plural(n, "film")));
          const found = list.map((x) => byKey.get(x.name + "|" + x.year)).filter(Boolean);
          if (found.length) out.appendChild(filmsList(found, { limit: 0 }));
          list.filter((x) => !byKey.get(x.name + "|" + x.year)).forEach((x) => out.appendChild(mk("p", "hint", x.name + " (" + x.year + ") : film non trouvé sur TMDB")));
        };
        cell.addEventListener("click", show);
        cell.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(); } });
      }
      place(cell, (dt.getDay() + 6) % 7 + 2, Math.floor((off + i) / 7) + 2);
    }
    const sc = mk("div", "calscroll"); sc.appendChild(grid); box.appendChild(sc);
    box.appendChild(mk("p", "hint", ""));
  }

  /* ---------- Watchlist : heures à rattraper et films qui y traînent depuis le plus longtemps ---------- */
  function sinceTxt(iso) {
    if (!isIso(iso)) return "date inconnue";
    const a = fromIso(iso), b = new Date();
    let m = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() - (b.getDate() < a.getDate() ? 1 : 0);
    if (m < 1) { const d = Math.max(0, Math.round((b - a) / 864e5)); return "depuis " + plural(d, "jour"); }
    const y = Math.floor(m / 12); m %= 12;
    return "depuis " + (y ? y + (y > 1 ? " ans" : " an") + (m ? " " + m + " mois" : "") : m + " mois");
  }
  function renderWatchlist() {
    const panel = $("wlPanel");
    const have = new Set(films.map(keyOf)), seen = new Set(), wl = [];
    watchlist.forEach((f) => {
      const k = keyOf(f);
      if (have.has(k) || seen.has(k)) return;   // déjà vu : plus à rattraper
      seen.add(k);
      const c = cache[k];
      wl.push(c && c.ok ? Object.assign({ name: f.name, year: parseInt(f.year, 10), uri: f.uri, r: null, added: f.date }, c) : { name: f.name, year: parseInt(f.year, 10), added: f.date, miss: 1 });
    });
    panel.hidden = !wl.length;
    if (!wl.length) { $("wlMiss").hidden = true; return; }
    const min = wl.reduce((s, x) => s + (x.rt || 0), 0), unknownList = wl.filter((x) => !x.rt);
    $("wlH").textContent = nf.format(Math.round(min / 60));
    $("wlSub").textContent = fmtDur(min) + " pour " + plural(wl.length, "film") + ", soit " + nf1(min / 1440) + " jours sans dormir"
      + ".";
    // Films sans durée : listés dans un menu déroulant, uniquement s'il y en a
    const wm = $("wlMiss"), wlist = $("wlMissList"); wlist.textContent = "";
    wm.hidden = !unknownList.length;
    if (unknownList.length) {
      $("wlMissN").textContent = unknownList.length + (unknownList.length > 1 ? " films sans durée, non comptés dans les heures" : " film sans durée, non compté dans les heures");
      unknownList.forEach((x) => {
        const li = document.createElement("li");
        li.textContent = x.name + " (" + x.year + ")" + (x.miss ? " · film non trouvé sur TMDB" : " · durée absente sur TMDB");
        wlist.appendChild(li);
      });
    }
    const dated = wl.filter((x) => isIso(x.added)).sort((a, b) => a.added.localeCompare(b.added) || a.name.localeCompare(b.name)).slice(0, 5);
    const age = (x) => Math.max(1, (new Date() - fromIso(x.added)) / 864e5), mx = dated.length ? age(dated[0]) : 1;
    rank("wlOld", dated.map((x) => ({
      film: x.miss ? null : x, label: x.name + " (" + x.year + ")",
      value: sinceTxt(x.added) + " · ajouté le " + longDate(fromIso(x.added)), frac: age(x) / mx
    })), 0, "Aucune date d'ajout dans ta watchlist.");
  }

  /* ---------- Tags du journal : les 5 tags les plus utilisés ---------- */
  function renderTags(byKey) {
    const panel = $("tagPanel"), tags = new Map();
    diaryRows.forEach((r) => (r.tags || []).forEach((t) => {
      const k = t.toLowerCase(), it = byKey.get(r.name + "|" + r.year);
      if (!tags.has(k)) tags.set(k, { label: t, films: new Map(), sessions: 0 });
      const g = tags.get(k); g.sessions++;
      if (it) g.films.set(r.name + "|" + r.year, it);
    }));
    const rows = Array.from(tags.values()).map((g) => {
      const items = Array.from(g.films.values()), rated = items.filter((x) => x.r != null);
      return { label: g.label, items: items, n: items.length, sessions: g.sessions, min: items.reduce((s, x) => s + (x.rt || 0), 0), avg: rated.length ? mean(rated.map((x) => x.r)) : null };
    }).filter((g) => g.n).sort((a, b) => b.n - a.n || b.sessions - a.sessions || a.label.localeCompare(b.label)).slice(0, 5);
    panel.hidden = !rows.length;
    if (!rows.length) return;
    const max = rows[0].n;
    rank("tags", rows.map((g) => ({
      label: g.label, items: g.items,
      value: plural(g.n, "film") + " · " + (g.avg != null ? nf1(g.avg) + " ★" : "non noté") + " · " + Math.round(g.min / 60) + " h",
      frac: g.n / max
    })));
  }

  $("yearSel").addEventListener("change", () => { yearChoice = +$("yearSel").value; if (lastByKey) renderYear(lastByKey); });

  /* ---------- Explorateur : filtres combinables sur tous tes films ---------- */
  const mkEl = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  let lastAll = [], exLimit = 15;
  const EX_IDS = ["exGenre", "exCountry", "exDec", "exLang", "exMin", "exMax", "exLike", "exQ", "exSort"];
  const normCode = (c) => (c === "SU" ? "RU" : c);
  function renderExplorer(all) {
    lastAll = all;
    const panel = $("explPanel"); panel.hidden = !all.length;
    if (!all.length) return;
    const fill = (id, first, opts) => {
      const s = $(id), cur = s.value; s.textContent = "";
      s.appendChild(Object.assign(mkEl("option", "", first), { value: "" }));
      opts.forEach((o) => s.appendChild(Object.assign(mkEl("option", "", o[1]), { value: o[0] })));
      if (opts.some((o) => String(o[0]) === cur)) s.value = cur;
    };
    fill("exGenre", "Tous les genres", group(all, (x) => x.g).sort(byCount).map((g) => [g.k, g.k + " (" + g.n + ")"]));
    fill("exCountry", "Tous les pays", group(all, (x) => (x.c || []).map(normCode)).sort(byCount).map((g) => [g.k, safeName(regionNames, g.k) + " (" + g.n + ")"]));
    fill("exDec", "Toutes les époques", group(all, (x) => [Math.floor(x.year / 10) * 10]).sort((a, b) => b.k - a.k).map((g) => [g.k, g.k + "s (" + g.n + ")"]));
    const stars = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((v) => [v, nf1(v) + " ★"]);
    fill("exMin", "Note min", stars); fill("exMax", "Note max", stars);
    runExplorer(true);
  }
  function runExplorer(reset) {
    if (reset) exLimit = 15;
    const v = (id) => $(id).value, g = v("exGenre"), c = v("exCountry"), d = v("exDec"), lg = v("exLang"), q = (v("exQ") || "").trim().toLowerCase();
    const mn = v("exMin") === "" ? null : +v("exMin"), mx = v("exMax") === "" ? null : +v("exMax");
    const list = lastAll.filter((x) =>
      (!g || (x.g || []).indexOf(g) >= 0) && (!c || (x.c || []).map(normCode).indexOf(c) >= 0) && (!d || Math.floor(x.year / 10) * 10 === +d)
      && (!lg || (lg === "vo" ? x.l && x.l !== "en" : x.l === "en"))
      && (mn == null || (x.r != null && x.r >= mn)) && (mx == null || (x.r != null && x.r <= mx))
      && (!$("exLike").checked || x.liked) && (!q || x.name.toLowerCase().indexOf(q) >= 0));
    const sorts = {
      note: (a, b) => (b.r == null ? -1 : b.r) - (a.r == null ? -1 : a.r) || b.v - a.v,
      recent: (a, b) => b.year - a.year, ancien: (a, b) => a.year - b.year,
      long: (a, b) => (b.rt || 0) - (a.rt || 0), pop: (a, b) => b.n - a.n, titre: (a, b) => a.name.localeCompare(b.name)
    };
    list.sort(sorts[v("exSort")] || sorts.note);
    const min = list.reduce((s, x) => s + (x.rt || 0), 0), rated = list.filter((x) => x.r != null), pub = list.filter((x) => x.v > 0 && x.n >= 50);
    const sum = $("exSum");
    sum.textContent = list.length
      ? plural(list.length, "film") + " (" + Math.round(list.length / lastAll.length * 100) + " % de tes films) · " + fmtDur(min) + " de cinéma"
        + (rated.length ? " · ta moyenne " + nf1(mean(rated.map((x) => x.r))) + " ★" : "")
        + (pub.length ? " · moyenne TMDB " + nf1(mean(pub.map((x) => x.v / 2))) + " ★" : "")
      : "Aucun film ne correspond à ces filtres.";
    const box = $("exList"); box.textContent = "";
    if (list.length) box.appendChild(filmsList(list, { limit: exLimit, sort: "none" }));
    $("exMore").hidden = list.length <= exLimit;
    $("exMore").textContent = "Afficher plus (" + Math.min(15, list.length - exLimit) + " de plus sur " + (list.length - exLimit) + ")";
  }
  EX_IDS.forEach((id) => $(id).addEventListener("input", () => runExplorer(true)));
  $("exMore").addEventListener("click", () => { exLimit += 15; runExplorer(false); });
  $("exReset").addEventListener("click", () => {
    EX_IDS.forEach((id) => { const e = $(id); if (e.type === "checkbox") e.checked = false; else e.value = id === "exSort" ? "note" : ""; });
    runExplorer(true);
  });

  /* ---------- Défi entre cinéphiles : chacun exporte une « carte », l'autre l'importe (rien ne passe par un serveur) ---------- */
  /* ---------- Films non trouvés : vérification et correction à la main ---------- */
  let lastMissing = [], keepScroll = false;
  function missItem(f) {
    const li = mkEl("li", "missitem");
    li.appendChild(mkEl("b", "", f.name + " (" + f.year + ")"));
    const links = mkEl("span", "misslinks");
    const lk = (t, u) => { const a = mkEl("a", "", t); a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; };
    links.appendChild(lk("Chercher sur TMDB", "https://www.themoviedb.org/search/movie?query=" + encodeURIComponent(f.name)));
    if (/^https?:\/\//.test(f.uri || "")) links.appendChild(lk("Voir sur Letterboxd", f.uri));
    li.appendChild(links);
    const row = mkEl("span", "missfix");
    const inp = mkEl("input"); inp.type = "text"; inp.placeholder = "ID ou lien TMDB du film"; inp.setAttribute("aria-label", "ID ou lien TMDB pour " + f.name);
    const btn = mkEl("button", "ghost small", "Associer"); btn.type = "button";
    const msg = mkEl("span", "hint");
    const go = () => {
      const raw = inp.value.trim();
      if (/\/tv\//.test(raw)) { msg.textContent = "C'est une série : il faut un film."; return; }
      const m = raw.match(/(\d{1,9})/);
      if (!m) { msg.textContent = "Colle l'identifiant ou le lien de la page du film sur TMDB."; return; }
      msg.textContent = "Recherche…"; btn.disabled = true;
      fetchById(+m[1], apiKey()).then((res) => {
        cache[keyOf(f)] = res; fixes[keyOf(f)] = +m[1]; saveFixes(); saveCache();
        const d = $("missPanel").querySelector("details"), wasOpen = d && d.open;
        keepScroll = true; render();
        const d2 = $("missPanel").querySelector("details"); if (d2 && wasOpen) d2.open = true;
      }).catch(() => { btn.disabled = false; msg.textContent = "Film introuvable avec cet identifiant."; });
    };
    btn.addEventListener("click", go);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    row.append(inp, btn); li.append(row, msg);
    return li;
  }
  $("missDl").addEventListener("click", () => {
    const q = (t) => '"' + String(t).replace(/"/g, '""') + '"';
    const csv = "Name,Year,Letterboxd URI\n" + lastMissing.map((f) => [q(f.name), f.year, q(f.uri || "")].join(",")).join("\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = "films-non-trouves.csv";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  $("fixDl").addEventListener("click", () => {
    const keys = Object.keys(fixes);
    const txt = "// Corrections manuelles : \"Titre|Année\": identifiant du film sur TMDB.\nwindow.TMDB_FIXES = {\n" + keys.map((k) => "  " + JSON.stringify(k) + ": " + (+fixes[k] || 0)).join(",\n") + "\n};\n";
    const url = URL.createObjectURL(new Blob([txt], { type: "text/javascript" }));
    const a = document.createElement("a"); a.href = url; a.download = "corrections.js";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  let mates = [];
  function buildCard() {
    const all = lastAll, rated = all.filter((x) => x.r != null);
    const gc = {}, dc = {}, cs = new Set();
    all.forEach((x) => {
      (x.g || []).forEach((g) => { gc[g] = (gc[g] || 0) + 1; });
      const d = Math.floor(x.year / 10) * 10; dc[d] = (dc[d] || 0) + 1;
      (x.c || []).forEach((c) => cs.add(normCode(c)));
    });
    const longest = all.slice().sort((a, b) => (b.rt || 0) - (a.rt || 0))[0];
    return {
      app: "lb-stats-card", v: 1, user: username || "Anonyme", at: isoOf(new Date()),
      n: all.length, min: all.reduce((s, x) => s + (x.rt || 0), 0), avg: rated.length ? mean(rated.map((x) => x.r)) : null,
      fives: rated.filter((x) => x.r === 5).length, likes: likes ? likes.size : null, nc: cs.size,
      vo: all.length ? all.filter((x) => x.l && x.l !== "en").length / all.length : 0,
      long: longest ? { name: longest.name, rt: longest.rt || 0 } : { name: "", rt: 0 },
      gc: gc, dc: dc, f: all.map((x) => [x.name, x.year, x.r, x.i || 0, x.rt || 0])
    };
  }
  function parseCard(txt) {
    let c; try { c = JSON.parse(txt); } catch (e) { return null; }
    if (!c || c.app !== "lb-stats-card" || c.v !== 1 || !Array.isArray(c.f)) return null;
    const num = (x) => (Number.isFinite(+x) ? +x : 0);
    const obj = (o) => { const r = {}; if (o && typeof o === "object") Object.keys(o).slice(0, 100).forEach((k) => { r[String(k).slice(0, 60)] = num(o[k]); }); return r; };
    const f = c.f.slice(0, 20000).filter((a) => Array.isArray(a) && typeof a[0] === "string")
      .map((a) => [a[0].slice(0, 200), num(a[1]), a[2] == null ? null : Math.min(5, Math.max(0.5, num(a[2]))), Math.max(0, Math.floor(num(a[3]))), num(a[4])]);
    if (!f.length) return null;
    return {
      user: String(c.user || "Anonyme").slice(0, 40), n: f.length, min: num(c.min), avg: c.avg == null ? null : num(c.avg), fives: num(c.fives),
      likes: c.likes == null ? null : num(c.likes), nc: num(c.nc), vo: num(c.vo),
      long: { name: String((c.long && c.long.name) || "").slice(0, 200), rt: num(c.long && c.long.rt) }, gc: obj(c.gc), dc: obj(c.dc), f: f
    };
  }
  const cosine = (a, b) => {
    const ks = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))); let s = 0, x = 0, y = 0;
    ks.forEach((k) => { const p = a[k] || 0, q = b[k] || 0; s += p * q; x += p * p; y += q * q; });
    return x && y ? s / Math.sqrt(x * y) : 0;
  };
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
  const fk = (f) => f[0] + "|" + f[1];

  function renderMates() {
    const box = $("mates"); box.textContent = "";
    mates.forEach((m, i) => {
      const b = mkEl("button", "ghost small", m.user + " · " + plural(m.n, "film")); b.type = "button";
      b.addEventListener("click", () => { box.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); renderDuel(m); });
      box.appendChild(b);
    });
  }
  function listBlock(title, rows, empty) {
    const d = mkEl("div", "duelblock"); d.appendChild(mkEl("h4", "", title));
    if (!rows.length) { d.appendChild(mkEl("p", "hint", empty)); return d; }
    const ul = mkEl("ul", "duellist");
    rows.forEach((r) => {
      const li = mkEl("li");
      let t;
      if (r.id) { t = mkEl("a", "", r.label); t.href = "https://www.themoviedb.org/movie/" + r.id; t.target = "_blank"; t.rel = "noopener noreferrer"; } else t = mkEl("span", "", r.label);
      li.append(t, mkEl("em", "", r.note)); ul.appendChild(li);
    });
    d.appendChild(ul); return d;
  }

  function renderDuel(you) {
    const box = $("duelBody"); box.textContent = "";
    const me = buildCard(), A = me.user === you.user ? "Toi" : me.user, B = you.user === me.user ? you.user + " (autre carte)" : you.user;
    const mine = new Map(me.f.map((f) => [fk(f), f])), theirs = new Map(you.f.map((f) => [fk(f), f]));
    const common = me.f.filter((f) => theirs.has(fk(f)));
    const both = common.filter((f) => f[2] != null && theirs.get(fk(f))[2] != null);

    // Compatibilité : goûts sur les films en commun, genres, époques
    const parts = [];
    if (both.length >= 5) {
      const r = pearson(both.map((f) => f[2]), both.map((f) => theirs.get(fk(f))[2]));
      parts.push(["Même avis sur les films vus en commun", (r + 1) / 2, both.length + " films notés par vous deux, corrélation " + nf1(r)]);
    }
    parts.push(["Mêmes genres", cosine(me.gc, you.gc), "ressemblance des genres regardés"]);
    parts.push(["Mêmes époques", cosine(me.dc, you.dc), "ressemblance des décennies regardées"]);
    const score = Math.round(mean(parts.map((p) => p[1])) * 100);
    const head = mkEl("div", "duelhead");
    head.append(mkEl("div", "bigscore", score + " %"), mkEl("div", "", "de compatibilité entre " + A + " et " + B + " · " + plural(common.length, "film") + " en commun"));
    box.appendChild(head);
    const pl = mkEl("ul", "duelparts");
    parts.forEach((p) => { const li = mkEl("li"); li.append(mkEl("span", "", p[0] + " : " + Math.round(p[1] * 100) + " %"), mkEl("em", "", p[2])); pl.appendChild(li); });
    box.appendChild(pl);

    // Manches : un point par catégorie gagnée
    const rounds = [
      ["Heures de cinéma", me.min, you.min, (v) => Math.round(v / 60) + " h"],
      ["Films vus", me.n, you.n, (v) => nf.format(v)],
      ["Spectateur le plus généreux", me.avg, you.avg, (v) => nf1(v) + " ★"],
      ["Coups de foudre (5 ★)", me.fives, you.fives, (v) => nf.format(v)],
      ["Pays explorés", me.nc, you.nc, (v) => nf.format(v)],
      ["Ouverture au cinéma non anglophone", me.vo, you.vo, (v) => Math.round(v * 100) + " %"],
      ["Film le plus long vu", me.long.rt, you.long.rt, (v) => fmtDur(v)],
      ["Coups de cœur", me.likes, you.likes, (v) => nf.format(v)]
    ].filter((r) => r[1] != null && r[2] != null);
    let pa = 0, pb = 0;
    const rb = mkEl("div", "rounds"); rb.appendChild(mkEl("h4", "", "Le duel en " + rounds.length + " manches"));
    rounds.forEach((r) => {
      const w = r[1] > r[2] ? 1 : r[1] < r[2] ? 2 : 0; if (w === 1) pa++; if (w === 2) pb++;
      const row = mkEl("div", "round");
      row.append(mkEl("b", w === 1 ? "win" : "", r[3](r[1])), mkEl("span", "", r[0]), mkEl("b", w === 2 ? "win" : "", r[3](r[2])));
      rb.appendChild(row);
    });
    rb.appendChild(mkEl("p", "lead small", pa === pb ? "Égalité parfaite : " + pa + " manches partout." : (pa > pb ? A : B) + " l'emporte " + Math.max(pa, pb) + " manches à " + Math.min(pa, pb) + "."));
    box.appendChild(rb);

    // Listes : films en commun adorés, désaccords, à découvrir chacun de son côté
    const fl = (f, note) => ({ label: f[0] + " (" + f[1] + ")", id: f[3], note: note });
    const star = (v) => nf1(v) + " ★";
    const loved = both.filter((f) => f[2] >= 4 && theirs.get(fk(f))[2] >= 4).sort((a, b) => b[2] + theirs.get(fk(b))[2] - a[2] - theirs.get(fk(a))[2]).slice(0, 5);
    const clash = both.map((f) => ({ f: f, d: Math.abs(f[2] - theirs.get(fk(f))[2]) })).filter((e) => e.d >= 1.5).sort((a, b) => b.d - a.d).slice(0, 5);
    const forMe = you.f.filter((f) => f[2] != null && f[2] >= 4.5 && !mine.has(fk(f))).sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0])).slice(0, 5);
    const forYou = me.f.filter((f) => f[2] != null && f[2] >= 4.5 && !theirs.has(fk(f))).sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0])).slice(0, 5);
    const lists = mkEl("div", "duellists");
    lists.append(
      listBlock("Vous les avez adorés tous les deux", loved.map((f) => fl(f, star(f[2]) + " / " + star(theirs.get(fk(f))[2]))), "Pas encore 4 ★ ou plus des deux côtés."),
      listBlock("Vos plus gros désaccords", clash.map((e) => fl(e.f, A + " " + star(e.f[2]) + " / " + you.user + " " + star(theirs.get(fk(e.f))[2]))), "Aucun écart d'au moins 1,5 ★ : vous êtes d'accord."),
      listBlock(you.user + " te conseille (à voir)", forMe.map((f) => fl(f, star(f[2]))), "Rien de noté 4,5 ★ ou plus que tu n'aies déjà vu."),
      listBlock("Tu conseilles à " + you.user + " (à voir)", forYou.map((f) => fl(f, star(f[2]))), "Rien de noté 4,5 ★ ou plus que " + you.user + " n'ait déjà vu.")
    );
    box.appendChild(lists);

    // Jeux : connais-tu les goûts de l'autre personne ?
    const game = mkEl("div", "guess"); box.appendChild(game);
    buildGames(game, me, you, theirs, both);
  }

  /* ---------- Jeux du défi : trois façons de tester si tu connais les goûts de l'autre ---------- */
  function buildGames(host, me, you, theirs, both) {
    const P = you.user, star = (v) => nf1(v) + " ★";
    const info = new Map(lastAll.map((x) => [x.name + "|" + x.year, x]));
    const imgOf = (name, year, w) => {
      const x = info.get(name + "|" + year);
      if (!x || !x.p) return null;
      const im = document.createElement("img"); im.src = IMG + "w185" + x.p; im.alt = ""; im.width = w || 69; im.height = Math.round((w || 69) * 1.5); return im;
    };
    const bestKey = (id, n) => "lb-best|" + id + "|" + P + "|" + n;
    const getBest = (id, n) => { try { return +localStorage.getItem(bestKey(id, n)) || 0; } catch (e) { return 0; } };
    const setBest = (id, n, v) => { try { localStorage.setItem(bestKey(id, n), String(v)); } catch (e) {} };
    const rated = you.f.filter((f) => f[2] != null);

    const head = mkEl("div", "gamehead");
    head.appendChild(mkEl("h4", "", "Jeux : connais-tu les goûts de " + P + " ?"));
    const stage = mkEl("div", "gamestage");
    const nsel = mkEl("select"); nsel.setAttribute("aria-label", "Nombre de manches");
    [5, 10].forEach((n) => { const o = mkEl("option", "", n + " manches"); o.value = n; nsel.appendChild(o); });
    const modes = mkEl("div", "gamemodes");

    const GAMES = [
      { id: "guess", name: "Devine la note", desc: "Un film que vous avez vu tous les deux : quelle note a donnée " + P + " ? Un indice (note TMDB) coûte 1 point.", need: both.length >= 3, why: "il faut au moins 3 films notés par vous deux (vous en avez " + both.length + ")", maxPer: 3, goodAt: 2 },
      { id: "pair", name: "Lequel a la meilleure note ?", desc: "Deux films au choix : lequel a reçu la meilleure note de " + P + " ? Les films peuvent être ceux que tu n'as pas vus.", need: rated.length >= 8, why: "il faut au moins 8 films notés dans la carte de " + P, maxPer: 2, goodAt: 2 },
      { id: "sign", name: "Plus ou moins que toi", desc: "Sur un film vu par vous deux : la note de " + P + " est-elle plus haute, identique ou plus basse que la tienne ?", need: both.length >= 3, why: "il faut au moins 3 films notés par vous deux (vous en avez " + both.length + ")", maxPer: 3, goodAt: 2 }
    ];

    // Moteur commun : manches, série, bonus, récapitulatif et record
    function run(g, n) {
      const rounds = g.make(n);
      let i = 0, score = 0, streak = 0; const log = [];
      const step = () => {
        stage.textContent = "";
        if (i >= rounds.length) return finish();
        stage.appendChild(mkEl("p", "gameprog", g.name + " · manche " + (i + 1) + " sur " + rounds.length + " · score " + score + (streak >= 2 ? " · série de " + streak : "")));
        const bx = mkEl("div", "gameround"); stage.appendChild(bx);
        rounds[i](bx, (pts, msg, line) => {
          let bonus = 0;
          if (pts >= g.goodAt) { streak++; if (streak >= 3) bonus = 1; } else streak = 0;
          score += pts + bonus; log.push(line + " (" + (pts + bonus >= 0 ? "+" : "") + (pts + bonus) + (bonus ? ", dont 1 de bonus série" : "") + ")");
          bx.appendChild(mkEl("p", "lead small", msg + (bonus ? " Série de " + streak + " bonnes manches : +1 point de bonus !" : "")));
          const nx = mkEl("button", "", i + 1 < rounds.length ? "Manche suivante" : "Voir mon score"); nx.type = "button";
          nx.addEventListener("click", () => { i++; step(); }); bx.appendChild(nx); nx.focus();
        });
      };
      const finish = () => {
        const mx = rounds.length * g.maxPer, pct = mx ? score / mx : 0, prev = getBest(g.id, rounds.length);
        stage.appendChild(mkEl("h4", "", "Score : " + score + " / " + mx + " (" + Math.round(pct * 100) + " %)"));
        stage.appendChild(mkEl("p", "lead small", pct >= 0.8 ? "Tu connais très bien les goûts de " + P + "." : pct >= 0.5 ? "Pas mal : tu connais bien les goûts de " + P + "." : pct >= 0.3 ? "Les goûts de " + P + " te surprennent parfois." : "Les goûts de " + P + " te réservent encore beaucoup de surprises."));
        if (score > prev) { setBest(g.id, rounds.length, score); stage.appendChild(mkEl("p", "lead small", prev ? "Nouveau record ! (ancien : " + prev + ")" : "Premier score enregistré dans ce navigateur.")); }
        else stage.appendChild(mkEl("p", "hint", "Ton record sur " + rounds.length + " manches : " + prev + "."));
        const ul = mkEl("ul", "gamelog"); log.forEach((t) => ul.appendChild(mkEl("li", "", t))); stage.appendChild(ul);
        const again = mkEl("button", "", "Rejouer"); again.type = "button"; again.addEventListener("click", () => run(g, n));
        const back = mkEl("button", "ghost", "Changer de jeu"); back.type = "button"; back.addEventListener("click", () => { stage.textContent = ""; });
        const bar = mkEl("div", "duelbar"); bar.append(again, back); stage.appendChild(bar);
      };
      step();
    }

    GAMES[0].make = (n) => shuffle(both).slice(0, n).map((f) => (bx, done) => {
      const real = theirs.get(fk(f))[2], x = info.get(f[0] + "|" + f[1]);
      const row = mkEl("div", "guessrow"), im = imgOf(f[0], f[1]); if (im) row.appendChild(im);
      const tx = mkEl("div"); tx.append(mkEl("b", "", f[0] + " (" + f[1] + ")"), mkEl("span", "", "Ta note : " + star(f[2]) + ". Quelle note a donnée " + P + " ?"));
      row.appendChild(tx); bx.appendChild(row);
      let hinted = false;
      const hintBox = mkEl("p", "hint");
      if (x && x.v > 0 && x.n >= 50) {
        const hb = mkEl("button", "ghost small", "Indice : note moyenne TMDB (−1 point)"); hb.type = "button";
        hb.addEventListener("click", () => { hinted = true; hb.remove(); hintBox.textContent = "Note moyenne du grand public sur TMDB : " + star(x.v / 2) + "."; });
        bx.appendChild(hb);
      }
      bx.appendChild(hintBox);
      const bt = mkEl("div", "guessbtns");
      [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].forEach((v) => {
        const b = mkEl("button", "ghost small", nf1(v) + " ★"); b.type = "button";
        b.addEventListener("click", () => {
          const diff = Math.abs(v - real); let gain = diff === 0 ? 3 : diff <= 0.5 ? 2 : diff <= 1 ? 1 : 0;
          if (hinted) gain = Math.max(0, gain - 1);
          bt.querySelectorAll("button").forEach((y) => { y.disabled = true; });
          done(gain, P + " a mis " + star(real) + " : " + (diff === 0 ? "en plein dans le mille !" : diff <= 0.5 ? "très proche." : diff <= 1 ? "pas loin." : "loin du compte.") + (hinted ? " (indice utilisé : −1)" : ""),
            f[0] + " : " + star(v) + " proposé, " + star(real) + " réel");
        });
        bt.appendChild(b);
      });
      bx.appendChild(bt);
    });

    GAMES[1].make = (n) => {
      const pool = shuffle(rated), pairs = [];
      while (pool.length >= 2 && pairs.length < n) {
        const a = pool.pop(); const j = pool.findIndex((b) => Math.abs(b[2] - a[2]) >= 1);
        if (j >= 0) pairs.push([a, pool.splice(j, 1)[0]]);
      }
      return pairs.map((pr) => (bx, done) => {
        bx.appendChild(mkEl("p", "lead small", "Lequel de ces deux films a reçu la meilleure note de " + P + " ?"));
        const wrap = mkEl("div", "pairbtns");
        pr.forEach((f, idx) => {
          const b = mkEl("button", "ghost pairbtn"); b.type = "button";
          const im = imgOf(f[0], f[1], 92); if (im) b.appendChild(im);
          b.append(mkEl("b", "", f[0]), mkEl("span", "", String(f[1])));
          b.addEventListener("click", () => {
            const other = pr[1 - idx], ok = f[2] > other[2];
            wrap.querySelectorAll("button").forEach((y) => { y.disabled = true; });
            done(ok ? 2 : 0, (ok ? "Bien vu" : "Raté") + " : " + P + " a mis " + star(pr[0][2]) + " à « " + pr[0][0] + " » et " + star(pr[1][2]) + " à « " + pr[1][0] + " ».",
              pr[0][0] + " (" + star(pr[0][2]) + ") contre " + pr[1][0] + " (" + star(pr[1][2]) + ") : " + (ok ? "trouvé" : "raté"));
          });
          wrap.appendChild(b);
        });
        bx.appendChild(wrap);
      });
    };

    GAMES[2].make = (n) => shuffle(both).slice(0, n).map((f) => (bx, done) => {
      const real = theirs.get(fk(f))[2], truth = real > f[2] ? "plus" : real < f[2] ? "moins" : "pareil";
      const row = mkEl("div", "guessrow"), im = imgOf(f[0], f[1]); if (im) row.appendChild(im);
      const tx = mkEl("div"); tx.append(mkEl("b", "", f[0] + " (" + f[1] + ")"), mkEl("span", "", "Ta note : " + star(f[2]) + ". Celle de " + P + " est…"));
      row.appendChild(tx); bx.appendChild(row);
      const bt = mkEl("div", "guessbtns");
      [["plus", "Plus haute"], ["pareil", "Identique"], ["moins", "Plus basse"]].forEach((o) => {
        const b = mkEl("button", "ghost small", o[1]); b.type = "button";
        b.addEventListener("click", () => {
          const ok = o[0] === truth; bt.querySelectorAll("button").forEach((y) => { y.disabled = true; });
          done(ok ? (truth === "pareil" ? 3 : 2) : 0, (ok ? "Bien vu" : "Raté") + " : " + P + " a mis " + star(real) + (truth === "pareil" ? ", la même note que toi." : truth === "plus" ? ", plus que toi." : ", moins que toi."),
            f[0] + " : " + star(f[2]) + " pour toi, " + star(real) + " pour " + P + " : " + (ok ? "trouvé" : "raté"));
        });
        bt.appendChild(b);
      });
      bx.appendChild(bt);
    });

    GAMES.forEach((g) => {
      const card = mkEl("div", "gamecard" + (g.need ? "" : " off"));
      card.appendChild(mkEl("b", "", g.name)); card.appendChild(mkEl("span", "", g.desc));
      const b5 = getBest(g.id, 5), b10 = getBest(g.id, 10);
      if (g.need && (b5 || b10)) card.appendChild(mkEl("em", "", "Records : " + (b5 ? b5 + " / " + 5 * g.maxPer + " sur 5" : "") + (b5 && b10 ? " · " : "") + (b10 ? b10 + " / " + 10 * g.maxPer + " sur 10" : "")));
      if (g.need) { const b = mkEl("button", "small", "Jouer"); b.type = "button"; b.addEventListener("click", () => run(g, +nsel.value)); card.appendChild(b); }
      else card.appendChild(mkEl("em", "", "Pas assez de données : " + g.why + "."));
      modes.appendChild(card);
    });
    const nrow = mkEl("label", "gamen", "Nombre de manches "); nrow.appendChild(nsel);
    host.append(head, nrow, modes, stage);
  }
  // Nouveau fichier chargé : on efface la dernière comparaison (elle concernait un autre profil)
  function resetDuel() {
    if (!$("duelBody")) return;
    $("duelBody").textContent = ""; $("cardMsg").textContent = "";
    $("mates").querySelectorAll("button").forEach((b) => b.classList.remove("on"));
    lastAll = []; $("duelPanel").hidden = true; $("explPanel").hidden = true;
  }
  function renderDuelPanel() {
    $("duelPanel").hidden = !lastAll.length; renderMates();
  }
  $("cardDl").addEventListener("click", () => {
    const c = buildCard(), url = URL.createObjectURL(new Blob([JSON.stringify(c)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "carte-cinephile-" + (c.user || "profil").replace(/[^a-z0-9_-]+/gi, "_") + ".json";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  $("cardIn").addEventListener("change", (e) => {
    const msg = $("cardMsg"); msg.textContent = ""; let bad = 0, last = null, left = e.target.files.length;
    Array.from(e.target.files).forEach((file) => {
      if (file.size > 5e6) { bad++; if (!--left) done(); return; }
      const rd = new FileReader();
      rd.onload = () => {
        const c = parseCard(String(rd.result));
        if (!c) bad++; else {
          const i = mates.findIndex((m) => m.user === c.user);
          if (i >= 0) mates[i] = c; else mates.push(c);
          last = c;
        }
        if (!--left) done();
      };
      rd.onerror = () => { bad++; if (!--left) done(); };
      rd.readAsText(file);
    });
    function done() {
      e.target.value = "";
      renderMates();
      if (bad) msg.textContent = bad + (bad > 1 ? " fichiers ne sont pas des cartes valides." : " fichier n'est pas une carte valide.") + " Il faut le fichier .json téléchargé depuis ce site.";
      if (last) { const bs = $("mates").querySelectorAll("button"); if (bs.length) bs[mates.indexOf(last)].click(); }
    }
  });

  // Courbe lissée passant par des points (interpolation monotone : ne descend jamais sous la base)
  function smoothPath(pts) {
    const n = pts.length, dx = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], q = a * a + b * b;
      if (q > 9) { const k = 3 / Math.sqrt(q); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = "M" + pts[0][0].toFixed(1) + "," + pts[0][1].toFixed(1);
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += " C" + (pts[i][0] + h).toFixed(1) + "," + (pts[i][1] + t[i] * h).toFixed(1) + " "
        + (pts[i + 1][0] - h).toFixed(1) + "," + (pts[i + 1][1] - t[i + 1] * h).toFixed(1) + " "
        + pts[i + 1][0].toFixed(1) + "," + pts[i + 1][1].toFixed(1);
    }
    return d;
  }

  // Répartition des notes : barres arrondies en dégradé, courbe lissée, repère de la moyenne
  function drawHist(rs, avg) {
    const NS = "http://www.w3.org/2000/svg";
    const el = (name, attrs, text) => {
      const e = document.createElementNS(NS, name);
      Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
      if (text != null) e.textContent = text;
      return e;
    };
    const vals = [], counts = [];
    for (let i = 0; i < 10; i++) { vals.push(0.5 + i * 0.5); counts.push(rs.filter((r) => r === 0.5 + i * 0.5).length); }
    const W = 640, H = 300, L = 14, R = 14, T = 56, B = 50;
    const step = (W - L - R) / 10, bw = step * 0.64, y0 = H - B, cmax = Math.max.apply(null, counts.concat([1]));
    const cx = (i) => L + step * i + step / 2;
    const cy = (c) => y0 - (c / cmax) * (y0 - T);
    const svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Répartition de tes notes, de 0,5 à 5 étoiles" });

    const defs = el("defs");
    const g1 = el("linearGradient", { id: "hbar", x1: 0, y1: 0, x2: 0, y2: 1 });
    g1.append(el("stop", { offset: "0", style: "stop-color:var(--accent2);stop-opacity:.9" }), el("stop", { offset: "1", style: "stop-color:var(--accent2);stop-opacity:.25" }));
    const g2 = el("linearGradient", { id: "harea", x1: 0, y1: 0, x2: 0, y2: 1 });
    g2.append(el("stop", { offset: "0", style: "stop-color:var(--accent);stop-opacity:.28" }), el("stop", { offset: "1", style: "stop-color:var(--accent);stop-opacity:0" }));
    defs.append(g1, g2); svg.appendChild(defs);

    // Repères horizontaux discrets
    [0.5, 1].forEach((f) => svg.appendChild(el("line", { class: "hgrid", x1: L, x2: W - R, y1: y0 - f * (y0 - T), y2: y0 - f * (y0 - T) })));

    // Barres arrondies en haut
    const r = 6;
    counts.forEach((c, i) => {
      const x = cx(i) - bw / 2, y = cy(c), h = y0 - y;
      const d = h > r
        ? "M" + x + "," + y0 + " V" + (y + r) + " Q" + x + "," + y + " " + (x + r) + "," + y + " H" + (x + bw - r) + " Q" + (x + bw) + "," + y + " " + (x + bw) + "," + (y + r) + " V" + y0 + " Z"
        : "M" + x + "," + y0 + " V" + (y0 - Math.max(h, 1)) + " H" + (x + bw) + " V" + y0 + " Z";
      const bar = el("path", { class: "hbar" + (c === cmax ? " peak" : ""), d: d });
      bar.appendChild(el("title", {}, nf1(vals[i]) + " ★ : " + c + (c > 1 ? " films" : " film") + " (" + Math.round(c / rs.length * 100) + " %)"));
      svg.appendChild(bar);
    });

    // Courbe lissée et zone sous la courbe
    const pts = counts.map((c, i) => [cx(i), cy(c)]);
    const line = smoothPath(pts);
    svg.appendChild(el("path", { class: "harea", d: line + " L" + pts[9][0].toFixed(1) + "," + y0 + " L" + pts[0][0].toFixed(1) + "," + y0 + " Z" }));
    svg.appendChild(el("path", { class: "hcurve", d: line }));
    pts.forEach((p, i) => { if (counts[i] > 0) svg.appendChild(el("circle", { class: "hdot", cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: 3.5 })); });

    // Nombre de films au-dessus de chaque barre
    counts.forEach((c, i) => { if (c > 0) svg.appendChild(el("text", { class: "hcnt" + (c === cmax ? " peak" : ""), x: cx(i), y: cy(c) - 10, "text-anchor": "middle" }, c)); });

    // Axe
    svg.appendChild(el("line", { class: "base", x1: L, x2: W - R, y1: y0, y2: y0 }));
    vals.forEach((v, i) => svg.appendChild(el("text", { class: "hlab", x: cx(i), y: y0 + 20, "text-anchor": "middle" }, String(v).replace(".", ","))));
    svg.appendChild(el("text", { class: "hax", x: W / 2, y: H - 8, "text-anchor": "middle" }, "Note (étoiles)"));

    // Repère de la moyenne
    const ax = Math.max(L + step / 2, Math.min(W - R - step / 2, L + step * ((avg - 0.5) / 0.5) + step / 2));
    svg.appendChild(el("line", { class: "havg", x1: ax, x2: ax, y1: 30, y2: y0 }));
    const lx = Math.max(62, Math.min(W - 62, ax));
    svg.appendChild(el("rect", { class: "hpill", x: lx - 58, y: 8, width: 116, height: 24, rx: 12 }));
    svg.appendChild(el("text", { class: "hpilltxt", x: lx, y: 24.5, "text-anchor": "middle" }, "Moyenne " + nf1(avg) + " ★"));

    const box = $("hist"); box.textContent = ""; box.appendChild(svg);
  }


  // Graphique à deux axes : barres = nombre de films (axe de droite), courbe lissée = note moyenne (axe de gauche)
  // o : { box, labels, counts, avgs (null si pas de note), best (indice de la meilleure note), tipBar(i), tipDot(i), xTitle, aria }
  function drawCombo(o) {
    const NS = "http://www.w3.org/2000/svg";
    const el = (name, attrs, text) => {
      const e = document.createElementNS(NS, name);
      Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
      if (text != null) e.textContent = text;
      return e;
    };
    const n = o.labels.length, W = 640, H = 330, L = 40, R = 40, T = 34, B = 56, y0 = H - B;
    const step = (W - L - R) / n, bw = Math.min(step * 0.62, 52);
    const cx = (i) => L + step * i + step / 2;
    const cmax = Math.max.apply(null, o.counts.concat([1]));
    const ts = Math.max(1, Math.ceil(cmax / 5)), top = ts * 5;
    const yC = (c) => y0 - (c / top) * (y0 - T), yA = (a) => y0 - (a / 5) * (y0 - T);
    const svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": o.aria });

    for (let k = 0; k <= 5; k++) {
      const y = y0 - (k / 5) * (y0 - T);
      if (k > 0) svg.appendChild(el("line", { class: "hgrid", x1: L, x2: W - R, y1: y, y2: y }));
      svg.appendChild(el("text", { class: "caxl", x: L - 8, y: y + 4, "text-anchor": "end" }, String(k)));
      svg.appendChild(el("text", { class: "caxl", x: W - R + 8, y: y + 4, "text-anchor": "start" }, String(k * ts)));
    }
    svg.appendChild(el("text", { class: "hax", x: L - 8, y: 14, "text-anchor": "start" }, "Note ★"));
    svg.appendChild(el("text", { class: "hax", x: W - R + 8, y: 14, "text-anchor": "end" }, "Films"));

    const r = 5, peak = cmax;
    o.counts.forEach((c, i) => {
      if (!c) return;
      const x = cx(i) - bw / 2, y = yC(c), h = y0 - y;
      const d = h > r
        ? "M" + x + "," + y0 + " V" + (y + r) + " Q" + x + "," + y + " " + (x + r) + "," + y + " H" + (x + bw - r) + " Q" + (x + bw) + "," + y + " " + (x + bw) + "," + (y + r) + " V" + y0 + " Z"
        : "M" + x + "," + y0 + " V" + (y0 - Math.max(h, 1)) + " H" + (x + bw) + " V" + y0 + " Z";
      const bar = el("path", { class: "cbar" + (c === peak ? " peak" : ""), d: d });
      bar.appendChild(el("title", {}, o.tipBar(i)));
      svg.appendChild(bar);
    });

    // Courbe lissée, par tronçons (un trou dans les données coupe la courbe)
    const runs = []; let cur = [];
    o.avgs.forEach((a, i) => { if (a == null) { if (cur.length) runs.push(cur); cur = []; } else cur.push([cx(i), yA(a), i]); });
    if (cur.length) runs.push(cur);
    runs.forEach((pts) => { if (pts.length > 1) svg.appendChild(el("path", { class: "hcurve", d: smoothPath(pts) })); });
    runs.forEach((pts) => pts.forEach((p) => {
      const best = p[2] === o.best;
      const dot = el("circle", { class: best ? "cbest" : "hdot", cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: best ? 6 : 3.5 });
      dot.appendChild(el("title", {}, o.tipDot(p[2])));
      svg.appendChild(dot);
      svg.appendChild(el("text", { class: "cval", x: p[0].toFixed(1), y: (p[1] - 11).toFixed(1), "text-anchor": "middle" }, nf1(o.avgs[p[2]])));
    }));

    svg.appendChild(el("line", { class: "base", x1: L, x2: W - R, y1: y0, y2: y0 }));
    o.labels.forEach((t, i) => svg.appendChild(el("text", { class: "hlab", x: cx(i), y: y0 + 20, "text-anchor": "middle" }, t)));
    if (o.xTitle) svg.appendChild(el("text", { class: "hax", x: W / 2, y: H - 8, "text-anchor": "middle" }, o.xTitle));
    const box = $(o.box); box.textContent = ""; box.appendChild(svg);
  }
  const plural = (n, w) => nf.format(n) + " " + w + (n > 1 ? "s" : "");

  // Catégorie d'un rôle selon sa place au générique, ramenée à la taille du casting
  // (0 principal, 1 secondaire, 2 petite apparition). Seuils faciles à ajuster ci-dessous.
  const TIERS = ["rôle principal", "rôle secondaire", "petite apparition"];
  const TIER_CFG = { mainPct: 0.15, mainMin: 5, mainMax: 12, secPct: 0.4, secMin: 10, secMax: 25 };
  function tiersOf(x) {
    if (x._t) return x._t;
    const ids = (x.m || []).concat(x.f || [], x.u || [], x.o || []), size = ids.length, c = TIER_CFG;
    const main = Math.max(c.mainMin, Math.min(c.mainMax, Math.ceil(size * c.mainPct)));
    const sec = Math.min(c.secMax, Math.max(c.secMin, Math.ceil(size * c.secPct)));
    const t = new Map();
    ids.forEach((id, i) => { if (!t.has(id)) t.set(id, i + 1 <= main ? 0 : i + 1 <= sec ? 1 : 2); });
    x._t = t; return t;
  }
  let lastRated = null;
  function renderBestActors() {
    if (!lastRated) return;
    const min = +$("actMin").value, sel = [0, 1, 2].map((i) => $("actT" + i).checked);
    $("actMinV").textContent = min;
    if (!sel.some(Boolean)) { rank("bestActors", [], 0, "Coche au moins une catégorie de rôle."); return; }
    const gs = group(lastRated, (x) => Array.from(tiersOf(x)).filter((e) => sel[e[1]]).map((e) => e[0]))
      .filter((g) => g.nr >= min).map((g) => Object.assign(g, { a: g.sum / g.nr }))
      .sort((a, b) => b.a - a.a || b.nr - a.nr || nameOf(a.k).localeCompare(nameOf(b.k))).slice(0, 10);
    rank("bestActors", gs.map((g) => ({
      label: nameOf(g.k), person: g.k, items: g.items, roleOf: (m) => TIERS[tiersOf(m).get(g.k)],
      value: nf1(g.a) + " ★ · " + g.nr + (g.nr > 1 ? " films" : " film"), frac: g.a / 5
    })), 0, "Aucun acteur ni aucune actrice avec au moins " + min + (min > 1 ? " films notés" : " film noté") + " dans ces catégories.");
  }
  ["actMin", "actT0", "actT1", "actT2"].forEach((id) => $(id).addEventListener("input", renderBestActors));

  // Durée des films : moins d'1 h, puis par tranches de 30 min, jusqu'à plus de 3 h
  const DUR = [
    { l: "< 1 h", lo: 0, hi: 60 }, { l: "1 h – 1 h 30", lo: 60, hi: 90 }, { l: "1 h 30 – 2 h", lo: 90, hi: 120 },
    { l: "2 h – 2 h 30", lo: 120, hi: 150 }, { l: "2 h 30 – 3 h", lo: 150, hi: 180 }, { l: "> 3 h", lo: 180, hi: 1e9 }
  ];
  function renderDuration(all) {
    const timed = all.filter((x) => x.rt > 0), box = $("durBox");
    const gs = DUR.map((b) => { const it = timed.filter((x) => x.rt >= b.lo && x.rt < b.hi), rt = it.filter((x) => x.r != null); return { n: it.length, nr: rt.length, a: rt.length ? mean(rt.map((x) => x.r)) : null }; });
    box.hidden = timed.length < 10;
    if (box.hidden) return;
    let best = -1;
    gs.forEach((g, i) => { if (g.a != null && (best < 0 || g.a > gs[best].a)) best = i; });
    drawCombo({
      box: "durChart", labels: DUR.map((b) => b.l), counts: gs.map((g) => g.n), avgs: gs.map((g) => g.a), best: best,
      xTitle: "Durée du film", aria: "Nombre de films et note moyenne selon la durée du film",
      tipBar: (i) => DUR[i].l + " : " + plural(gs[i].n, "film"),
      tipDot: (i) => DUR[i].l + " : " + nf1(gs[i].a) + " ★ de moyenne sur " + plural(gs[i].nr, "film") + " noté"
    });
    $("durNote").textContent = "Barres : nombre de films (axe de droite). Courbe : ta note moyenne (axe de gauche)."
      + (best >= 0 ? " Tranche la mieux notée : " + DUR[best].l + " (" + nf1(gs[best].a) + " ★)." : "");
  }

  function renderRatings(all, genres) {
    const rated = all.filter((x) => x.r != null);
    const has = rated.length >= 10;
    ["profilePanel", "histPanel", "bestGenresPanel", "bestDirsPanel", "bestActorsPanel", "decAvgPanel", "morePanel", "lessPanel", "fivePanel"].forEach((id) => { $(id).hidden = !has; });
    if (!has) return;

    const rs = rated.map((x) => x.r);
    const avg = mean(rs), med = median(rs), sd = stdev(rs);

    drawHist(rs, avg);
    $("histNote").textContent = "Moyenne " + nf1(avg) + " / 5, médiane " + nf1(med) + ", sur " + nf.format(rs.length) + " films notés.";

    // Comparaison avec le grand public (films avec assez de votes)
    const pub = rated.filter((x) => x.n >= 200 && x.v > 0);
    const gap = pub.length >= 10 ? mean(pub.map((x) => x.r)) - mean(pub.map((x) => x.v / 2)) : null;

    // Genres et réalisateurs les mieux notés
    const gAvg = group(rated, (x) => x.g).filter((g) => g.nr >= 8).map((g) => Object.assign(g, { a: g.sum / g.nr })).sort((a, b) => b.a - a.a || b.nr - a.nr).slice(0, 10);
    rank("bestGenres", gAvg.map((g) => ({ label: g.k, items: g.items, value: nf1(g.a) + " ★ · " + g.nr + " films", frac: g.a / 5 })), 0, "Pas encore 8 films notés dans un même genre.");
    const dAvg = group(rated, (x) => x.d).filter((g) => g.nr >= 3).map((g) => Object.assign(g, { a: g.sum / g.nr })).sort((a, b) => b.a - a.a || b.nr - a.nr).slice(0, 10);
    rank("bestDirs", dAvg.map((g) => ({ label: nameOf(g.k), person: g.k, items: g.items, value: nf1(g.a) + " ★ · " + g.nr + " films", frac: g.a / 5 })), 0, "Pas encore 3 films notés du même réalisateur.");

    lastRated = rated; renderBestActors();

    // Note moyenne par décennie
    const decAvg = group(rated, (x) => [Math.floor(x.year / 10) * 10]).sort((a, b) => a.k - b.k).map((g) => Object.assign(g, { a: g.sum / g.nr }));
    rank("decAvg", decAvg.map((g) => ({ label: g.k + "s", items: g.items, value: nf1(g.a) + " ★ · " + g.nr + (g.nr > 1 ? " films" : " film"), frac: g.a / 5 })));

    // Écarts avec le public
    const diffs = pub.map((x) => ({ x: x, d: x.r - x.v / 2 }));
    const up = diffs.filter((e) => e.d > 0).sort((a, b) => b.d - a.d).slice(0, 10);
    const down = diffs.filter((e) => e.d < 0).sort((a, b) => a.d - b.d).slice(0, 10);
    const diffRow = (e, mx) => ({ film: e.x, label: e.x.name + " (" + e.x.year + ")", value: "toi " + nf1(e.x.r) + " · TMDB " + nf1(e.x.v / 2), frac: Math.abs(e.d) / mx });
    const mx = Math.max.apply(null, diffs.map((e) => Math.abs(e.d)).concat([1]));
    rank("more", up.map((e) => diffRow(e, mx)));
    rank("less", down.map((e) => diffRow(e, mx)));

    // 5 étoiles : affiches en bas de page
    const fv = $("fives"); fv.textContent = "";
    const fives = rated.filter((x) => x.r === 5).sort((a, b) => a.year - b.year || a.name.localeCompare(b.name));
    $("fiveN").textContent = fives.length;
    $("fivePanel").hidden = !fives.length;
    fives.forEach((x) => {
      const fg = document.createElement("figure");
      clickable(fg, x);
      if (x.p) {
        const im = document.createElement("img");
        im.src = IMG + "w342" + x.p; im.alt = "Affiche de " + x.name; im.loading = "lazy";
        fg.appendChild(im);
      } else { const ph = document.createElement("span"); ph.className = "ph"; fg.appendChild(ph); }
      const cp = document.createElement("figcaption");
      const nm = document.createElement("b"); nm.textContent = x.name;
      const yr = document.createElement("span"); yr.textContent = x.year;
      cp.append(nm, yr); fg.appendChild(cp); fv.appendChild(fg);
    });

    // Profil
    $("profileTitle").textContent = username ? "Profil de spectateur de " + username : "Ton profil de spectateur";
    const out = [];
    const add = (title, text) => out.push([title, text]);
    add(avg < 2.8 ? "Spectateur sévère" : avg < 3.3 ? "Spectateur équilibré" : avg < 3.7 ? "Spectateur plutôt généreux" : "Spectateur très généreux",
      "Ta moyenne est de " + nf1(avg) + " / 5. " + (avg >= 3.3 ? "Tu aimes une grande partie de ce que tu regardes." : "Tu en gardes peu au sommet."));
    if (gap !== null) {
      const g = Math.abs(gap) < 0.1 ? "Tu notes comme le grand public."
        : gap > 0 ? "Tu notes " + nf1(gap) + " point plus haut que le grand public (note TMDB)." : "Tu notes " + nf1(-gap) + " point plus bas que le grand public (note TMDB).";
      add(Math.abs(gap) < 0.1 ? "Dans la moyenne" : gap > 0 ? "Bon public" : "Critique exigeant", g);
    }
    const hi = rs.filter((r) => r >= 4.5).length / rs.length, lo = rs.filter((r) => r <= 2).length / rs.length;
    add(sd > 0.95 ? "Avis tranchés" : sd < 0.7 ? "Tout en nuances" : "Notation modérée",
      "Écart-type de " + nf1(sd) + " : " + (sd > 0.95 ? "tu utilises toute l'échelle." : sd < 0.7 ? "tu restes surtout au milieu de l'échelle." : "tu varies tes notes sans extrêmes.")
      + " " + Math.round(hi * 100) + " % de coups de foudre (4,5 ou plus), " + Math.round(lo * 100) + " % de déceptions (2 ou moins).");
    if (genres.length) add("Genre roi", genres[0].k + " domine : " + genres[0].n + " films, soit " + Math.round(genres[0].n / all.length * 100) + " % de ce que tu regardes.");
    const recent = all.filter((x) => x.year >= 2015).length / all.length, old = all.filter((x) => x.year < 1990).length / all.length;
    add(recent > 0.55 ? "Cinéma d'aujourd'hui" : old > 0.2 ? "Chasseur de classiques" : "Toutes les époques",
      Math.round(recent * 100) + " % de tes films sont sortis depuis 2015, " + Math.round(old * 100) + " % avant 1990.");
    const bestDec = decAvg.filter((g) => g.nr >= 10).sort((a, b) => b.a - a.a)[0];
    if (bestDec) add("Décennie favorite", "Les films des années " + bestDec.k + " sont ceux que tu notes le mieux : " + nf1(bestDec.a) + " / 5 en moyenne, sur " + bestDec.nr + " films.");
    const vo = all.filter((x) => x.l && x.l !== "en").length / all.length;
    add(vo > 0.3 ? "Ouvert sur le monde" : "Surtout anglophone", Math.round(vo * 100) + " % de tes films ne sont pas en anglais à l'origine.");
    const withRt = rated.filter((x) => x.rt > 0);
    if (withRt.length >= 20) {
      const r = pearson(withRt.map((x) => x.rt), withRt.map((x) => x.r));
      add(r > 0.15 ? "Fan de longs films" : r < -0.15 ? "Allergique aux longueurs" : "La durée ne compte pas",
        "Lien entre durée et note : " + nf1(r) + (r > 0.15 ? ". Plus c'est long, plus tu aimes." : r < -0.15 ? ". Plus c'est long, moins tu aimes." : ", presque aucun effet."));
    }
    renderDuration(all);
    const pl = $("profileList"); pl.textContent = "";
    out.forEach((o) => {
      const li = document.createElement("li");
      const b = document.createElement("b"); b.textContent = o[0] + ". ";
      li.append(b, document.createTextNode(o[1])); pl.appendChild(li);
    });
  }
})();
