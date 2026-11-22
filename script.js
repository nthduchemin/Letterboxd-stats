(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  let films = [];        // {name, year}
  let rewatches = [];    // {name, year}, lignes "Rewatch" du journal
  let ratings = null;    // Map "nom|année" -> note, ou null sans ratings.csv
  let likes = null;      // Set "nom|année", ou null
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
    films = parseCSV(texts.watched).filter((r) => r.Name).map((r) => ({ name: r.Name, year: r.Year }));
    rewatches = texts.diary
      ? parseCSV(texts.diary).filter((r) => r.Rewatch === "Yes" && r.Name).map((r) => ({ name: r.Name, year: r.Year }))
      : [];
    ratings = null; likes = null;
    if (texts.ratings) {
      ratings = new Map();
      parseCSV(texts.ratings).forEach((r) => { const v = parseFloat(r.Rating); if (r.Name && !isNaN(v)) ratings.set(r.Name + "|" + r.Year, v); });
    }
    if (texts.likes) {
      likes = new Set();
      parseCSV(texts.likes).forEach((r) => { if (r.Name) likes.add(r.Name + "|" + r.Year); });
    }
    if (!films.length) { showErr("Aucun film trouvé dans ce fichier. Il faut watched.csv, ou le ZIP complet."); return; }
    $("drop").classList.add("ok");
    $("dropTitle").textContent = name;
    $("dropSub").textContent = films.length + " films distincts"
      + (ratings ? ", " + ratings.size + " notes" : ", sans notes (dépose le ZIP pour les avoir)");
    $("rewatchRow").hidden = !rewatches.length;
    $("rewatchN").textContent = rewatches.length;
    update();
  }

  function setFile(file) {
    $("err").hidden = true;
    if (/\.zip$/i.test(file.name)) {
      if (!window.JSZip) { showErr("Le lecteur de ZIP n'a pas pu se charger. Dépose plutôt watched.csv."); return; }
      JSZip.loadAsync(file).then((zip) => {
        const get = (p) => { const f = zip.file(p); return f ? f.async("string") : Promise.resolve(""); };
        if (!zip.file("watched.csv")) { showErr("watched.csv est introuvable dans ce ZIP."); return; }
        return Promise.all([get("watched.csv"), get("diary.csv"), get("ratings.csv"), get("likes/films.csv")])
          .then((t) => load({ watched: t[0], diary: t[1], ratings: t[2], likes: t[3] }, file.name));
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
  $("key").addEventListener("input", update);

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
      const p = (k in cache) ? Promise.resolve() : lookup(f, key).then((res) => { cache[k] = res; });
      return p.catch((e) => { if (e.fatal) fatal = true; })
        .then(() => { done++; if (done % 10 === 0) { tick(); saveCache(); } return worker(); });
    };
    Promise.all([1, 2, 3, 4, 5, 6].map(worker)).then(() => {
      saveCache(); tick();
      running = false; $("go").hidden = false; $("stop").hidden = true; update();
      if (fatal) { showErr("TMDB a refusé la clé. Vérifie que tu as copié la « Clé API » en entier."); $("progress").hidden = true; return; }
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
    let list = items.slice().sort((a, b) => (b.r == null ? -1 : b.r) - (a.r == null ? -1 : a.r) || b.v - a.v || a.year - b.year);
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
  function filmCard(item) {
    const box = document.createElement("div"); box.className = "filmcard";
    const ph = document.createElement("span"); ph.className = "ph"; box.appendChild(ph);
    const tx = document.createElement("div"); tx.className = "pinfo"; box.appendChild(tx);
    const fill = () => {
      if (item.p && !box.querySelector("img")) {
        const im = document.createElement("img");
        im.src = IMG + "w185" + item.p; im.alt = ""; im.width = 92; im.height = 138;
        box.replaceChild(im, ph);
      }
      tx.textContent = "";
      const nm = document.createElement("b"); nm.textContent = item.name; tx.appendChild(nm);
      const line = (t) => { const s = document.createElement("span"); s.textContent = t; tx.appendChild(s); };
      line(isDate(item.rd) ? "Sorti le " + fmtDate(item.rd) : "Sorti en " + item.year);
      line("Ta note : " + (item.r != null ? nf1(item.r) + " ★" : "non notée") + " · Note moyenne TMDB : " + (item.v ? nf1(item.v / 2) + " / 5" : "non disponible"));
      line("Réalisé par " + (item.d && item.d.length ? item.d.map(nameOf).join(", ") : "réalisateur inconnu"));
      if (item.t && item.t.length) line("Avec " + item.t.map(nameOf).join(", "));
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
      cap.textContent = r.items.some((m) => m.r != null) ? "Tes 5 films les mieux notés" : "Les 5 films les mieux notés par TMDB";
      box.appendChild(cap);
    }
    box.appendChild(filmsList(r.items, { limit: r.person ? 0 : 5, roleOf: r.roleOf }));
    return box;
  }

  function rank(id, rows, maxVal, empty) {
    const ol = $(id); ol.textContent = "";
    if (!rows.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = empty || "Pas assez de données."; ol.appendChild(li); return; }
    rows.forEach((r) => {
      const li = document.createElement("li");
      let l;
      if ((r.items && r.items.length) || r.film) {
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

  function renderMap(ctry) {
    const M = window.WORLD_MAP, panel = $("mapPanel");
    if (!M || !ctry.length) { panel.hidden = true; return; }
    panel.hidden = false;
    const byCode = new Map(); ctry.forEach((g) => byCode.set(g.k, g));
    const max = ctry[0].n;
    // Niveau selon la part du pays le plus vu ; 1 ou 2 films restent toujours "très peu"
    const level = (n) => n <= 0 ? 0 : n <= 2 ? 1 : n >= max * 0.5 ? 4 : n >= max * 0.15 ? 3 : n >= max * 0.03 ? 2 : 1;
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
      return { name: safeName(regionNames, code), n: n, lv: lv, text: n === 0 ? "Aucun film vu" : n + (n > 1 ? " films" : " film") + " · " + SIGNS[lv] + " " + LEVELS[lv] };
    };
    const place = (e) => {
      const w = mapTip.offsetWidth, h = mapTip.offsetHeight;
      mapTip.style.left = Math.max(8, Math.min(e.clientX + 14, window.innerWidth - w - 8)) + "px";
      mapTip.style.top = Math.max(8, Math.min(e.clientY + 14, window.innerHeight - h - 8)) + "px";
    };
    svg.addEventListener("mousemove", (e) => {
      const code = e.target.getAttribute && e.target.getAttribute("data-code");
      if (!code) { mapTip.hidden = true; return; }
      const f = info(code);
      mapTip.textContent = "";
      const b = document.createElement("b"); b.textContent = f.name;
      const sp = document.createElement("span"); sp.textContent = f.text;
      mapTip.append(b, sp); mapTip.hidden = false; place(e);
    });
    svg.addEventListener("mouseleave", () => { mapTip.hidden = true; });
    // Clic : les 5 films les mieux notés du pays
    const sel = $("mapSel");
    svg.addEventListener("click", (e) => {
      const code = e.target.getAttribute && e.target.getAttribute("data-code");
      if (!code) return;
      const f = info(code), g = byCode.get(code);
      sel.textContent = ""; sel.hidden = false;
      const h = document.createElement("p"); h.className = "cap"; h.textContent = f.name + " : " + f.text;
      sel.appendChild(h);
      if (g) sel.appendChild(filmsList(g.items, { limit: 5 }));
    });

    // Légende : couleur et signe de chaque niveau, avec les nombres de films concernés
    const rng = [];
    for (let n = 1; n <= max; n++) { const l = level(n); rng[l] = rng[l] ? [rng[l][0], n] : [n, n]; }
    const lg = $("mapLegend"); lg.textContent = "";
    for (let l = 0; l <= 4; l++) {
      if (l > 0 && !rng[l]) continue;
      const li = document.createElement("li");
      const sw = document.createElement("span"); sw.className = "sw lv" + l;
      const tx = document.createElement("span");
      tx.textContent = (SIGNS[l] ? SIGNS[l] + " " : "") + LEVELS[l] + (l > 0 ? " (" + (rng[l][0] === rng[l][1] ? rng[l][0] : rng[l][0] + " à " + rng[l][1]) + ")" : "");
      li.append(sw, tx); lg.appendChild(li);
    }
    // Pays qui n'existent plus ou ne sont pas dessinés
    const other = ctry.filter((g) => !M.paths[g.k]);
    const oe = $("mapOther");
    oe.hidden = !other.length;
    if (other.length) oe.textContent = "Hors carte : " + other.map((g) => safeName(regionNames, g.k) + " (" + g.n + ")").join(", ") + ".";
  }

  /* ---------- Affichage ---------- */
  function render() {
    const withRe = $("rewatch").checked && rewatches.length;
    const all = [], missing = [];
    films.forEach((f) => {
      const c = cache[keyOf(f)];
      if (c && c.ok) all.push(Object.assign({ name: f.name, year: parseInt(f.year, 10), r: ratings && ratings.has(keyOf(f)) ? ratings.get(keyOf(f)) : null, liked: likes ? likes.has(keyOf(f)) : false }, c));
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
    const roleOf = (m, id) => (m.m.concat(m.f, m.u).indexOf(id) >= 0 ? "rôle majeur" : "second rôle");
    const men = group(all, (x) => x.m || []).sort(byCountP);
    rank("actorsM", countRows(named(men.slice(0, 10)), { tips: "people" }));
    const women = group(all, (x) => x.f || []).sort(byCountP);
    rank("actorsF", countRows(named(women.slice(0, 10)), { tips: "people" }));
    const everyone = group(all, (x) => [].concat(x.m || [], x.f || [], x.u || [], x.o || [])).sort(byCountP);
    rank("actorsAll", countRows(named(everyone.slice(0, 10)), { tips: "people", roleOf: roleOf }));
    const ctry = group(all, (x) => x.c).sort(byCount);
    ctry.forEach((c) => { c.label = safeName(regionNames, c.k); });
    rank("countries", countRows(ctry.slice(0, 10), { tips: "top" }));
    const lg = group(all, (x) => [x.l]).sort(byCount);
    lg.forEach((c) => { c.label = safeName(langNames, c.k); });
    rank("langs", countRows(lg.slice(0, 10), { tips: "top" }));
    renderMap(ctry);

    renderRatings(all, genres);

    // Plus revus : films revus au moins 2 fois
    const byKey = new Map(); all.forEach((x) => byKey.set(x.name + "|" + x.year, x));
    const reCount = new Map();
    rewatches.forEach((f) => { const k = keyOf(f); reCount.set(k, (reCount.get(k) || 0) + 1); });
    const reRows = Array.from(reCount.entries()).filter((e) => e[1] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10);
    $("rePanel").hidden = !reRows.length;
    if (reRows.length) rank("reTop", reRows.map((e) => ({ film: byKey.get(e[0]), label: e[0].split("|")[0], value: e[1] + " revisionnages", frac: e[1] / reRows[0][1] })));

    // Non trouvés
    const ul = $("missList"); ul.textContent = "";
    missing.forEach((m) => { const li = document.createElement("li"); li.textContent = m; ul.appendChild(li); });
    $("missN").textContent = missing.length;
    $("missPanel").hidden = !missing.length;

    $("results").hidden = false;
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderRatings(all, genres) {
    const rated = all.filter((x) => x.r != null);
    const has = rated.length >= 10;
    ["profilePanel", "histPanel", "bestGenresPanel", "bestDirsPanel", "morePanel", "lessPanel", "fivePanel"].forEach((id) => { $(id).hidden = !has; });
    if (!has) return;

    const rs = rated.map((x) => x.r);
    const avg = mean(rs), med = median(rs), sd = stdev(rs);

    // Histogramme (0,5 à 5)
    const bins = []; for (let v = 0.5; v <= 5; v += 0.5) bins.push(v);
    const counts = bins.map((v) => rs.filter((r) => r === v).length);
    const cmax = Math.max.apply(null, counts);
    const hist = $("hist"); hist.textContent = "";
    bins.forEach((v, i) => {
      const col = document.createElement("div"); col.className = "col";
      const n = document.createElement("em"); n.textContent = counts[i];
      const bar = document.createElement("i"); bar.style.height = (counts[i] / cmax * 100) + "%";
      const lab = document.createElement("span"); lab.textContent = String(v).replace(".", ",");
      col.append(n, bar, lab); hist.appendChild(col);
    });
    $("histNote").textContent = "Moyenne " + nf1(avg) + " / 5, médiane " + nf1(med) + ", sur " + nf.format(rs.length) + " films notés.";

    // Comparaison avec le grand public (films avec assez de votes)
    const pub = rated.filter((x) => x.n >= 200 && x.v > 0);
    const gap = pub.length >= 10 ? mean(pub.map((x) => x.r)) - mean(pub.map((x) => x.v / 2)) : null;

    // Genres et réalisateurs les mieux notés
    const gAvg = group(rated, (x) => x.g).filter((g) => g.nr >= 8).map((g) => Object.assign(g, { a: g.sum / g.nr })).sort((a, b) => b.a - a.a || b.nr - a.nr).slice(0, 10);
    rank("bestGenres", gAvg.map((g) => ({ label: g.k, items: g.items, value: nf1(g.a) + " ★ · " + g.nr + " films", frac: g.a / 5 })), 0, "Pas encore 8 films notés dans un même genre.");
    const dAvg = group(rated, (x) => x.d).filter((g) => g.nr >= 3).map((g) => Object.assign(g, { a: g.sum / g.nr })).sort((a, b) => b.a - a.a || b.nr - a.nr).slice(0, 10);
    rank("bestDirs", dAvg.map((g) => ({ label: nameOf(g.k), person: g.k, items: g.items, value: nf1(g.a) + " ★ · " + g.nr + " films", frac: g.a / 5 })), 0, "Pas encore 3 films notés du même réalisateur.");

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
    const vo = all.filter((x) => x.l && x.l !== "en").length / all.length;
    add(vo > 0.3 ? "Ouvert sur le monde" : "Surtout anglophone", Math.round(vo * 100) + " % de tes films ne sont pas en anglais à l'origine.");
    const withRt = rated.filter((x) => x.rt > 0);
    if (withRt.length >= 20) {
      const r = pearson(withRt.map((x) => x.rt), withRt.map((x) => x.r));
      add(r > 0.15 ? "Fan de longs films" : r < -0.15 ? "Allergique aux longueurs" : "La durée ne compte pas",
        "Lien entre durée et note : " + nf1(r) + (r > 0.15 ? ". Plus c'est long, plus tu aimes." : r < -0.15 ? ". Plus c'est long, moins tu aimes." : ", presque aucun effet."));
    }
    const pl = $("profileList"); pl.textContent = "";
    out.forEach((o) => {
      const li = document.createElement("li");
      const b = document.createElement("b"); b.textContent = o[0] + ". ";
      li.append(b, document.createTextNode(o[1])); pl.appendChild(li);
    });
  }
})();
