/* Undertow — North American tides breathing in real time
   Data: NOAA CO-OPS (Tides & Currents) */

(() => {
  const CANVAS = document.getElementById("c");
  const CTX = CANVAS.getContext("2d");
  const scrub = document.getElementById("scrub");
  const playBtn = document.getElementById("play");
  const timeLabel = document.getElementById("timeLabel");
  const modeLabel = document.getElementById("mode");
  const tip = document.getElementById("tip");
  const soundBtn = document.getElementById("sound");

  const STATE = {
    stations: [],
    times: [],
    idx: 0,
    playing: true,
    speed: 1, // hours advanced per frame tick (scaled by dt)
    hoursPerSec: 6, // accelerated: 6 tide-hours per real second
    dataMode: "snapshot",
    hover: null,
    dpr: 1,
    w: 0,
    h: 0,
    audioOn: false,
    audioCtx: null,
    oscs: [],
  };

  // Region of each station (used for threads + labels)
  function regionOf(s) {
    if (s.state === "HI") return "hawaii";
    if (s.state === "AK") return "alaska";
    if (s.state === "PR" || s.state === "VI") return "caribbean";
    if (s.lng < -110) return "pacific";
    if (s.lat < 30.8 && s.lng < -80.5) return "gulf";
    return "atlantic";
  }

  // Display lon/lat: tuck Hawaiʻi into the open SW corner, lift the Caribbean a touch
  function displayLL(s) {
    let lng = s.lng, lat = s.lat;
    if (s.state === "HI") { lng += 26; lat += 2; }
    if (s.state === "PR" || s.state === "VI") { lat += 2.5; }
    return [lng, lat * 1.0];
  }

  let BBOX = null;
  function computeBBox() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of STATE.stations) {
      const [lng, lat] = displayLL(s);
      x0 = Math.min(x0, lng); x1 = Math.max(x1, lng);
      y0 = Math.min(y0, lat); y1 = Math.max(y1, lat);
    }
    BBOX = { x0, x1, y0, y1 };
  }

  function layout() {
    const { w, h } = STATE;
    const mobile = w < 640;
    const colMax = Math.min(h * 0.16, 120);
    const padTop = (mobile ? 150 : 96) + colMax * 0.6;
    const padBot = mobile ? 150 : 118;
    const padX = Math.max(28, w * 0.06);
    const innerW = Math.max(50, w - padX * 2);
    const innerH = Math.max(50, h - padTop - padBot);
    const spanX = BBOX.x1 - BBOX.x0, spanY = BBOX.y1 - BBOX.y0;
    // degrees of longitude shrink with latitude (~cos 40°)
    const sx = innerW / spanX;
    let sy = innerH / spanY;
    sy = Math.min(sy, sx * 2.6);           // never stretch absurdly tall (mobile)
    sy = Math.max(sy, sx * 0.9);           // or absurdly flat
    const usedH = spanY * sy;
    const offY = padTop + Math.max(0, (innerH - usedH) / 2);
    return { padX, sx, sy, offY, colMax };
  }

  let L = null;
  function project(s) {
    const [lng, lat] = displayLL(s);
    return [L.padX + (lng - BBOX.x0) * L.sx, L.offY + (BBOX.y1 - lat) * L.sy];
  }

  function parseTime(t) {
    // "2026-10-05 14:00" GMT
    const [d, hm] = t.split(" ");
    const [Y, M, D] = d.split("-").map(Number);
    const [h, m] = hm.split(":").map(Number);
    return Date.UTC(Y, M - 1, D, h, m);
  }

  function formatTime(t) {
    const ms = parseTime(t);
    const d = new Date(ms);
    const opts = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" };
    return d.toLocaleString("en-US", opts) + " UTC";
  }

  function sampleAt(station, idx) {
    const v = station.v;
    const i = Math.max(0, Math.min(v.length - 1, Math.floor(idx)));
    const f = idx - i;
    if (i >= v.length - 1) return { h: v[v.length - 1], dh: 0 };
    const h = v[i] * (1 - f) + v[i + 1] * f;
    const dh = v[i + 1] - v[i];
    return { h, dh };
  }

  function nextExtremum(station, idx) {
    const v = station.v;
    const i0 = Math.max(1, Math.min(v.length - 2, Math.floor(idx)));
    // walk forward for next local max or min
    for (let i = i0; i < v.length - 1; i++) {
      const rising = v[i] >= v[i - 1];
      const nextRising = v[i + 1] >= v[i];
      if (rising && !nextRising) {
        return { kind: "high", t: STATE.times[i], h: v[i] };
      }
      if (!rising && nextRising) {
        return { kind: "low", t: STATE.times[i], h: v[i] };
      }
    }
    return null;
  }

  function resize() {
    const rect = CANVAS.getBoundingClientRect();
    STATE.dpr = Math.min(window.devicePixelRatio || 1, 2);
    STATE.w = rect.width;
    STATE.h = rect.height;
    CANVAS.width = Math.round(rect.width * STATE.dpr);
    CANVAS.height = Math.round(rect.height * STATE.dpr);
    CTX.setTransform(STATE.dpr, 0, 0, STATE.dpr, 0, 0);
  }

  function drawBackground() {
    const { w, h } = STATE;
    const g = CTX.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.5, w * 0.7);
    g.addColorStop(0, "#0c1524");
    g.addColorStop(0.55, "#070d18");
    g.addColorStop(1, "#04070e");
    CTX.fillStyle = g;
    CTX.fillRect(0, 0, w, h);

    // faint horizon wash
    const wash = CTX.createLinearGradient(0, h * 0.55, 0, h);
    wash.addColorStop(0, "rgba(20,40,70,0)");
    wash.addColorStop(1, "rgba(10,30,55,0.35)");
    CTX.fillStyle = wash;
    CTX.fillRect(0, 0, w, h);

    // soft star dust
    CTX.fillStyle = "rgba(180,200,230,0.12)";
    for (let i = 0; i < 60; i++) {
      const x = ((i * 97) % 1000) / 1000 * w;
      const y = ((i * 53) % 1000) / 1000 * h * 0.7;
      const r = (i % 3) * 0.4 + 0.4;
      CTX.beginPath();
      CTX.arc(x, y, r, 0, Math.PI * 2);
      CTX.fill();
    }
  }

  function colorFor(dh, amp) {
    // rising → teal/cyan, falling → rose/coral, slack → soft violet
    const t = Math.max(-1, Math.min(1, dh / Math.max(0.05, amp * 0.15)));
    if (t >= 0) {
      // slack to rising
      const u = t;
      return [
        Math.round(140 + (78 - 140) * u),
        Math.round(150 + (220 - 150) * u),
        Math.round(200 + (210 - 200) * u),
      ];
    } else {
      const u = -t;
      return [
        Math.round(140 + (255 - 140) * u),
        Math.round(150 + (110 - 150) * u),
        Math.round(200 + (150 - 200) * u),
      ];
    }
  }

  function drawStation(st, idx, alpha = 1) {
    const { w, h } = STATE;
    const [x, y] = project(st);
    const { h: level, dh } = sampleAt(st, idx);
    const range = Math.max(0.2, st.vmax - st.vmin);
    const norm = (level - st.vmin) / range; // 0..1
    const amp = range;

    // Column height scales with water level; also scale lightly by local amplitude so AK towers show
    // height: bigger tidal range → taller column (sqrt so Anchorage doesn't dwarf all)
    const ampScale = Math.min(1, 0.32 + Math.sqrt(amp / 9) * 0.68);
    const colH = 6 + norm * L.colMax * ampScale;
    const colW = Math.max(3, Math.min(7, 3.5 + amp * 0.4));

    const [r, g, b] = colorFor(dh, amp);
    const glowing = STATE.hover && STATE.hover.id === st.id;

    // soft ground glow
    const rg = CTX.createRadialGradient(x, y, 0, x, y, 28 + norm * 20);
    rg.addColorStop(0, `rgba(${r},${g},${b},${0.22 * alpha})`);
    rg.addColorStop(1, `rgba(${r},${g},${b},0)`);
    CTX.fillStyle = rg;
    CTX.beginPath();
    CTX.arc(x, y, 28 + norm * 20, 0, Math.PI * 2);
    CTX.fill();

    // column
    const top = y - colH;
    const grad = CTX.createLinearGradient(x, y, x, top);
    grad.addColorStop(0, `rgba(${r},${g},${b},${0.05 * alpha})`);
    grad.addColorStop(0.35, `rgba(${r},${g},${b},${0.55 * alpha})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},${0.95 * alpha})`);
    CTX.fillStyle = grad;
    CTX.beginPath();
    roundRect(CTX, x - colW / 2, top, colW, colH, colW / 2);
    CTX.fill();

    // bright tip / ring at water surface
    CTX.beginPath();
    CTX.arc(x, top, glowing ? 5.5 : 3.2, 0, Math.PI * 2);
    CTX.fillStyle = `rgba(255,255,255,${0.85 * alpha})`;
    CTX.fill();
    CTX.beginPath();
    CTX.arc(x, top, glowing ? 10 : 6.5, 0, Math.PI * 2);
    CTX.strokeStyle = `rgba(${r},${g},${b},${0.7 * alpha})`;
    CTX.lineWidth = 1.2;
    CTX.stroke();

    // base dot
    CTX.beginPath();
    CTX.arc(x, y, 2.2, 0, Math.PI * 2);
    CTX.fillStyle = `rgba(${r},${g},${b},${0.7 * alpha})`;
    CTX.fill();

    st._xy = [x, y];
    st._top = top;
    st._level = level;
    st._dh = dh;
    st._rgb = [r, g, b];
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  const REGION_NAMES = { atlantic: "ATLANTIC", gulf: "GULF", pacific: "PACIFIC", alaska: "ALASKA", hawaii: "HAWAIʻI", caribbean: "CARIBBEAN" };
  const REGION_OFF = { atlantic: [46, 10], gulf: [0, 46], pacific: [-70, 40], alaska: [0, 38], hawaii: [0, 34], caribbean: [0, 34] };

  function drawLabels() {
    CTX.save();
    CTX.font = "500 10px system-ui, sans-serif";
    CTX.textAlign = "center";
    CTX.fillStyle = "rgba(160,180,210,0.32)";
    const groups = {};
    for (const st of STATE.stations) {
      const r = regionOf(st);
      const [x, y] = project(st);
      (groups[r] = groups[r] || []).push([x, y]);
    }
    for (const [r, pts] of Object.entries(groups)) {
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      let [ox, oy] = REGION_OFF[r];
      if (STATE.w < 640 && r === "atlantic") { ox = 18; oy = 78; }
      const txt = REGION_NAMES[r].split("").join("\u2009");
      const half = CTX.measureText(txt).width / 2 + 8;
      CTX.fillText(txt, Math.min(STATE.w - half, Math.max(half, cx + ox)), cy + oy);
    }
    CTX.restore();
  }

  // Faint threads linking neighbouring stations along each coast; colour follows the tide
  const THREAD_ORDER = {
    atlantic: (a, b) => b.lat - a.lat,
    gulf: (a, b) => b.lng - a.lng,
    pacific: (a, b) => a.lat - b.lat,
    alaska: (a, b) => b.lng - a.lng,
    hawaii: (a, b) => a.lng - b.lng,
    caribbean: (a, b) => a.lng - b.lng,
  };
  function drawThreads() {
    const groups = {};
    for (const st of STATE.stations) (groups[regionOf(st)] = groups[regionOf(st)] || []).push(st);
    CTX.save();
    CTX.lineWidth = 1;
    for (const [r, list] of Object.entries(groups)) {
      list.sort(THREAD_ORDER[r]);
      for (let i = 0; i < list.length - 1; i++) {
        const a = list[i], b = list[i + 1];
        if (!a._xy || !b._xy) continue;
        const g = CTX.createLinearGradient(a._xy[0], a._xy[1], b._xy[0], b._xy[1]);
        g.addColorStop(0, `rgba(${a._rgb.join(",")},0.28)`);
        g.addColorStop(1, `rgba(${b._rgb.join(",")},0.28)`);
        CTX.strokeStyle = g;
        CTX.beginPath();
        CTX.moveTo(a._xy[0], a._xy[1]);
        CTX.lineTo(b._xy[0], b._xy[1]);
        CTX.stroke();
      }
    }
    CTX.restore();
  }

  function render() {
    if (!STATE.stations.length) return;
    if (!BBOX) computeBBox();
    L = layout();
    drawBackground();
    drawLabels();
    drawThreads();
    // draw far (west) first? just in order
    for (const st of STATE.stations) {
      drawStation(st, STATE.idx);
    }
    if (STATE.hover) {
      // redraw hovered on top
      drawStation(STATE.hover, STATE.idx, 1);
    }
  }

  function updateTip() {
    if (!STATE.hover) {
      tip.classList.remove("show");
      return;
    }
    const st = STATE.hover;
    const ext = nextExtremum(st, STATE.idx);
    const rising = st._dh >= 0;
    tip.innerHTML =
      `<strong>${st.label || st.name}</strong>` +
      `<span class="meta">${st.state || ""} · ${st._level.toFixed(2)} m MLLW · ${rising ? "rising" : "falling"}</span>` +
      (ext
        ? `<span class="meta">next ${ext.kind}: ${ext.h.toFixed(2)} m · ${formatTime(ext.t)}</span>`
        : "");
    tip.classList.add("show");
    const [x, y] = st._xy;
    const rect = CANVAS.getBoundingClientRect();
    let left = rect.left + x;
    let top = rect.top + (st._top ?? y) - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  let lastTs = 0;
  function tick(ts) {
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;

    if (STATE.playing && STATE.times.length) {
      STATE.idx += STATE.hoursPerSec * dt;
      if (STATE.idx >= STATE.times.length - 1) STATE.idx = 0;
      scrub.value = String(STATE.idx);
    }

    if (STATE.times.length) {
      const i = Math.floor(STATE.idx);
      const tt = STATE.times[Math.min(i, STATE.times.length - 1)];
      const isNow = Math.abs(parseTime(tt) + (STATE.idx - i) * 3600e3 - Date.now()) < 45 * 60e3;
      timeLabel.textContent = formatTime(tt) + (isNow ? " · now" : "");
    }

    render();
    updateTip();
    updateAudio();
    requestAnimationFrame(tick);
  }

  function hitTest(clientX, clientY) {
    const rect = CANVAS.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    let bestD = 28;
    for (const st of STATE.stations) {
      if (!st._xy) continue;
      const [sx, sy] = st._xy;
      const top = st._top ?? sy;
      // distance to column segment
      const dx = x - sx;
      const nearY = Math.max(top, Math.min(sy, y));
      const dy = y - nearY;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    return best;
  }

  function onPointer(e) {
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    STATE.hover = hitTest(t.clientX, t.clientY);
  }

  function setupAudio() {
    if (STATE.audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0.04;
    master.connect(ctx.destination);
    STATE.audioCtx = ctx;
    STATE.master = master;
    STATE.oscs = STATE.stations.map(() => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      g.gain.value = 0;
      o.connect(g);
      g.connect(master);
      o.start();
      return { o, g };
    });
  }

  function updateAudio() {
    if (!STATE.audioOn || !STATE.audioCtx) return;
    STATE.stations.forEach((st, i) => {
      const node = STATE.oscs[i];
      if (!node) return;
      const range = Math.max(0.2, st.vmax - st.vmin);
      const norm = (st._level - st.vmin) / range;
      const freq = 110 + norm * 220 + (i % 7) * 3;
      node.o.frequency.setTargetAtTime(freq, STATE.audioCtx.currentTime, 0.08);
      // only a few soft voices near hover / scattered
      const gain = STATE.hover && STATE.hover.id === st.id ? 0.35 : 0.04;
      node.g.gain.setTargetAtTime(gain * 0.15, STATE.audioCtx.currentTime, 0.1);
    });
  }

  function applyDataset(src, mode) {
    const keepIdx = STATE.times.length ? STATE.idx : null;
    STATE.stations = src.stations.map((s) => ({
      ...s,
      label: prettyName(s),
    }));
    STATE.times = STATE.stations[0].t.slice();
    BBOX = null;
    STATE.dataMode = mode;
    modeLabel.textContent = mode;
    modeLabel.dataset.mode = mode;
    modeLabel.title = mode === "live"
      ? "Fetched live from NOAA CO-OPS on load"
      : "Using baked NOAA snapshot (offline / API unavailable)";

    const now = Date.now();
    let start = 0;
    for (let i = 0; i < STATE.times.length; i++) {
      if (parseTime(STATE.times[i]) <= now) start = i;
    }
    STATE.idx = keepIdx != null ? Math.min(keepIdx, STATE.times.length - 1) : start;
    scrub.min = 0;
    scrub.max = STATE.times.length - 1;
    scrub.step = 0.05;
    scrub.value = String(STATE.idx);
    document.getElementById("status").textContent = `${STATE.stations.length} stations`;
  }

  async function loadData() {
    // Snapshot first for instant paint, then quietly upgrade to live NOAA
    let snapshot;
    try {
      const r = await fetch("data.json", { cache: "no-store" });
      snapshot = await r.json();
    } catch (e) {
      console.error("snapshot load failed", e);
      throw e;
    }
    applyDataset(snapshot, "snapshot");

    // Background live refresh (CORS is open; bounded ~35 stations, once per load)
    tryLive(snapshot).then((live) => {
      if (live) applyDataset(live, "live");
    });
  }

  function prettyName(s) {
    if (s.label && !/^\d/.test(s.label)) return s.label;
    // clean NOAA uppercase names
    let n = s.name
      .replace(/\s*\(.*?\)\s*/g, " ")
      .replace(/,/g, "")
      .trim();
    n = n
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
    if (s.state) n += `, ${s.state}`;
    return n;
  }

  async function tryLive(snapshot) {
    // Fetch a small subset live to confirm CORS + freshness; if OK, rebuild from live for all
    // Keep requests modest: one date range, all stations (bounded ~35)
    const begin = snapshot.begin;
    const end = snapshot.end;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      // Probe one station first
      const probeId = snapshot.stations[0].id;
      const probeUrl =
        `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
        `?product=predictions&application=dreamer` +
        `&begin_date=${begin}&end_date=${end}` +
        `&datum=MLLW&station=${probeId}` +
        `&time_zone=gmt&units=metric&interval=h&format=json`;
      const probe = await fetch(probeUrl, { signal: controller.signal });
      if (!probe.ok) throw new Error("probe fail");
      const probeJson = await probe.json();
      if (!probeJson.predictions || !probeJson.predictions.length) throw new Error("empty");

      // Fetch remaining in small batches
      const outStations = [];
      const ids = snapshot.stations;
      const batchSize = 5;
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map(async (meta) => {
            const url =
              `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
              `?product=predictions&application=dreamer` +
              `&begin_date=${begin}&end_date=${end}` +
              `&datum=MLLW&station=${meta.id}` +
              `&time_zone=gmt&units=metric&interval=h&format=json`;
            const r = await fetch(url, { signal: controller.signal });
            if (!r.ok) throw new Error("station fail " + meta.id);
            const j = await r.json();
            const preds = j.predictions || [];
            if (!preds.length) throw new Error("empty " + meta.id);
            const t = preds.map((p) => p.t);
            const v = preds.map((p) => parseFloat(p.v));
            return {
              id: meta.id,
              name: meta.name,
              label: meta.label,
              lat: meta.lat,
              lng: meta.lng,
              state: meta.state,
              t,
              v,
              vmin: Math.min(...v),
              vmax: Math.max(...v),
            };
          })
        );
        outStations.push(...results);
      }
      clearTimeout(timeout);
      return {
        ...snapshot,
        generated: new Date().toISOString(),
        stations: outStations,
        _live: true,
      };
    } catch (e) {
      clearTimeout(timeout);
      console.info("live fetch unavailable, using snapshot", e);
      return null;
    }
  }

  window.__undertow = STATE; // handy for debugging

  // UI
  playBtn.addEventListener("click", () => {
    STATE.playing = !STATE.playing;
    playBtn.textContent = STATE.playing ? "Pause" : "Play";
    playBtn.setAttribute("aria-pressed", STATE.playing ? "true" : "false");
  });

  scrub.addEventListener("input", () => {
    STATE.idx = parseFloat(scrub.value);
    STATE.playing = false;
    playBtn.textContent = "Play";
    playBtn.setAttribute("aria-pressed", "false");
  });

  soundBtn.addEventListener("click", async () => {
    setupAudio();
    if (STATE.audioCtx && STATE.audioCtx.state === "suspended") {
      await STATE.audioCtx.resume();
    }
    STATE.audioOn = !STATE.audioOn;
    soundBtn.textContent = STATE.audioOn ? "Sound on" : "Sound";
    soundBtn.setAttribute("aria-pressed", STATE.audioOn ? "true" : "false");
    if (!STATE.audioOn && STATE.oscs) {
      for (const n of STATE.oscs) n.g.gain.setTargetAtTime(0, STATE.audioCtx.currentTime, 0.05);
    }
  });

  CANVAS.addEventListener("pointermove", onPointer);
  CANVAS.addEventListener("pointerdown", onPointer);
  CANVAS.addEventListener("pointerleave", () => {
    STATE.hover = null;
  });

  window.addEventListener("resize", () => {
    resize();
    render();
  });

  // boot
  (async () => {
    resize();
    try {
      await loadData();
      // status set in applyDataset
      requestAnimationFrame(tick);
    } catch (e) {
      document.getElementById("status").textContent = "failed to load tide data";
      console.error(e);
    }
  })();
})();
