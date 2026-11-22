(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  let films = [];        // {name, year}
  let rewatches = [];    // {name, year}, lignes "Rewatch" du journal
  let ratings = null;    // Map "nom|année" -> note, ou null sans ratings.csv
  let likes = null;      // Set "nom|année", ou null
  let likeDates = [];   // {k: "nom|année", d: date du coup de cœur}, d'après likes.csv
  let diaryRows = [], username = "", favorites = [];   // journal, pseudo Letterboxd, liens du top 4
  let running = false, cancelled = false;

  const CACHE_KEY = "lb-film-cache-v5", PEOPLE_KEY = "lb-people-v5";   // v5 : casting complet, avec identifiants
  let cache = {}, people = {};                                          // people : identifiant TMDB -> nom
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
      ? parseCSV(texts.diary).filter((r) => r.Name).map((r) => ({ name: r.Name, year: r.Year, date: r["Watched Date"] || "", rewatch: r.Rewatch === "Yes" }))
      : [];
    rewatches = diaryRows.filter((r) => r.rewatch);
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
    update();
  }

  function setFile(file) {
    $("err").hidden = true;
    if (/\.zip$/i.test(file.name)) {
      if (!window.JSZip) { showErr("Le lecteur de ZIP n'a pas pu se charger. Dépose plutôt watched.csv."); return; }
      JSZip.loadAsync(file).then((zip) => {
        const get = (p) => { const f = zip.file(p); return f ? f.async("string") : Promise.resolve(""); };
        if (!zip.file("watched.csv")) { showErr("watched.csv est introuvable dans ce ZIP."); return; }
        return Promise.all([get("watched.csv"), get("diary.csv"), get("ratings.csv"), get("likes/films.csv"), get("profile.csv")])
          .then((t) => load({ watched: t[0], diary: t[1], ratings: t[2], likes: t[3], profile: t[4] }, file.name));
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
  function lookup(film, key) {
    return tmdb("search/movie", { query: film.name, primary_release_year: film.year }, key)
      .then((r) => bestMatch(r.results, film) || tmdb("search/movie", { query: film.name }, key).then((r2) => bestMatch(r2.results, film)))
      .then((m) => {
        if (!m) return { ok: 0 };
        return tmdb("movie/" + m.id, { language: "fr-FR", append_to_response: "credits" }, key).then((d) => {
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
    const queue = films.slice(); const total = films.length;
    let done = 0, fatal = false;
    running = true; cancelled = false; update();
    $("go").hidden = true; $("stop").hidden = false; $("progress").hidden = false;
    $("err").hidden = true; $("results").hidden = true;

    const tick = () => {
      $("fill").style.width = (done / total * 100) + "%";
      $("progText").textContent = done + " / " + total + " films";
    };
    tick();

    const worker = () => {
      if (cancelled || fatal || !queue.length) return Promise.resolve();
      const f = queue.shift(), k = keyOf(f);
      const c0 = cache[k];
      let p;
      if (!(k in cache) || (c0 && c0.ok && c0.col === undefined && !c0.i)) p = lookup(f, key).then((res) => { cache[k] = res; });
      else if (c0 && c0.ok && c0.col === undefined) {
        // Ancienne entrée du cache : on ne récupère que la collection (saga) du film
        p = tmdb("movie/" + c0.i, { language: "fr-FR" }, key).then((d) => {
          c0.col = d.belongs_to_collection ? d.belongs_to_collection.id : 0;
          c0.cn = d.belongs_to_collection ? d.belongs_to_collection.name : "";
        });
      } else p = Promise.resolve();
      return p.catch((e) => { if (e.fatal) fatal = true; })
        .then(() => { done++; if (done % 10 === 0) { tick(); saveCache(); } return worker(); });
    };
    Promise.all([1, 2, 3, 4, 5, 6].map(worker)).then(() => {
      saveCache(); tick();
      running = false; $("go").hidden = false; $("stop").hidden = true; update();
      if (fatal) { showErr("TMDB a refusé la clé. Retourne sur themoviedb.org > Paramètres > API et copie la valeur « Clé API » en entier, sans espace."); $("progress").hidden = true; return; }
      if (cancelled) { $("progText").textContent = "Arrêté à " + done + " / " + total + ". Relance pour reprendre là où tu t'étais arrêté."; return; }
      render();
    });
  });
  $("rewatch").addEventListener("change", () => { if (!$("results").hidden && !running) render(); });

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
    let list = items.slice().sort(o.sort === "pop"
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
      else missing.push(f.name + " (" + f.year + ")");
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

    // Non trouvés
    const ul = $("missList"); ul.textContent = "";
    missing.forEach((m) => { const li = document.createElement("li"); li.textContent = m; ul.appendChild(li); });
    $("missN").textContent = missing.length;
    $("missPanel").hidden = !missing.length;

    $("results").hidden = false;
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
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
    rank("coll", [], 0, "Chargement des sagas…");
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
      rank("coll", rows.map((r) => ({
        label: r.label, items: r.items, full: true, missing: r.missing,
        value: r.seen + " / " + r.total + " films" + (r.done ? " · complète ✓" : ""), frac: r.seen / r.total
      })), 0, "Impossible de charger les sagas pour le moment.");
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
      rank("weekdays", [], 0, "Rien à afficher pour cette année.");
      $("yearExtra").hidden = true;
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
    const rows = DAYS.map((name, d) => ({ name: name, n: per[d], ratio: per[d] / Math.max(1, occ[d]), items: items[d] }))
      .sort((a, b) => b.ratio - a.ratio || b.n - a.n);
    const top = rows[0], rmax = top.ratio || 1;
    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    $("yearSum").textContent = when + " : " + sessions.length + (sessions.length > 1 ? " films vus" : " film vu")
      + " (revisionnages compris), soit " + fmtDur(min) + " de cinéma. Ton jour favori : le " + top.name + ", avec " + top.n + (top.n > 1 ? " films" : " film") + ".";
    rank("weekdays", rows.map((r) => ({
      label: cap(r.name), items: r.items,
      value: "ratio " + nf2(r.ratio) + " · " + r.n + (r.n > 1 ? " films" : " film"),
      frac: r.ratio / rmax
    })));
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
  $("yearSel").addEventListener("change", () => { yearChoice = +$("yearSel").value; if (lastByKey) renderYear(lastByKey); });

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
