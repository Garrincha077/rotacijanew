(function(){
  let etfRealtimeTimer = null;

  function getMassiveKey() { return localStorage.getItem('etf_massive_key') || ''; }

  function setFetchStatus(msg) {
    const el = document.getElementById('etfFetchStatus');
    if (el) el.textContent = msg || '';
  }

  function calcEtfPerf(series) {
    if (!series || series.length < 60) return null;
    const byDate = [...series].sort((a,b) => a.date.localeCompare(b.date));
    const last = byDate[byDate.length - 1].close;
    const prev = byDate[byDate.length - 2]?.close;
    const pick = days => byDate[Math.max(0, byDate.length - days - 1)]?.close;
    const startY = byDate.find(p => p.date >= `${new Date().getFullYear()}-01-01`)?.close || byDate[0].close;
    const ma = days => {
      const seg = byDate.slice(Math.max(0, byDate.length - days));
      if (!seg.length) return null;
      return seg.reduce((a,b)=>a+b.close,0)/seg.length;
    };
    const ma50 = ma(50), ma150 = ma(150);
    const ret = base => base ? ((last - base) / base) * 100 : null;
    const trend = ma50 && ma150 ? (ma50 > ma150 ? 'Uzlazni' : 'Silazni') : 'Neutralan';
    let weinsteinStage = 'Stage 1 (Baza)';
    if (ma150 && last > ma150) weinsteinStage = 'Stage 2 (Uzlazni)';
    if (ma150 && last < ma150) weinsteinStage = 'Stage 4 (Silazni)';
    return { price:last, d1:ret(prev), w1:ret(pick(5)), m1:ret(pick(21)), ytd:ret(startY), y1:ret(pick(252)), trend, weinsteinStage };
  }

  async function fetchMassiveHistory(ticker){
    const key = getMassiveKey();
    if (!key) throw new Error('Nedostaje Massive key');
    const u = `/api/etf/history?ticker=${encodeURIComponent(ticker)}&years=3&apiKey=${encodeURIComponent(key)}`;
    const r = await fetch(u);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'history fail');
    return data.results || [];
  }

  window.refreshEtfData = async function refreshEtfData(){
    const universe = [...ETF_COUNTRY_LIST, ...ETF_THEME_LIST];
    const cache = {};
    let ok=0, fail=0;
    const failed=[];
    setFetchStatus('Dohvatam preko Python proxy /api/etf/history ...');
    for (const item of universe){
      try {
        const series = await fetchMassiveHistory(item.ticker);
        cache[item.ticker] = calcEtfPerf(series);
        ok++;
      } catch(e){
        cache[item.ticker] = null;
        fail++;
        failed.push(`${item.ticker}: ${e.message || 'greška'}`);
      }
    }
    localStorage.setItem('etf_perf_cache', JSON.stringify({ ts: Date.now(), data: cache }));
    renderEtfTables();
    setFetchStatus(fail ? `Greške (${fail}): ${failed.slice(0,8).join(' | ')}` : 'Dohvat uspješan preko backend proxy-ja.');
    showToast(`ETF osvježeno (proxy): ${ok} OK, ${fail} grešaka`, fail>0);
  };

  async function refreshEtfRealtime(){
    const key = getMassiveKey();
    const st = document.getElementById('etfRtStatus');
    if (!key) { if (st) st.textContent = 'RT: OFF (nema Massive key)'; return; }
    const allTickers = [...new Set([...ETF_COUNTRY_LIST, ...ETF_THEME_LIST].map(x => x.ticker))];
    const chunks = [];
    for (let i=0;i<allTickers.length;i+=40) chunks.push(allTickers.slice(i,i+40));
    const cache = (()=>{ try { return JSON.parse(localStorage.getItem('etf_perf_cache')||'{}').data || {}; } catch(e){ return {}; }})();
    let updated = 0;
    for (const part of chunks){
      const url = `/api/etf/snapshot?tickers=${encodeURIComponent(part.join(','))}&apiKey=${encodeURIComponent(key)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'snapshot fail');
      (data.tickers || []).forEach(r => {
        const t = r.ticker, price = r?.day?.c, prev = r?.prevDay?.c;
        if (!Number.isFinite(price)) return;
        if (!cache[t]) cache[t] = {};
        cache[t].price = price;
        cache[t].d1 = Number.isFinite(prev) && prev ? ((price - prev) / prev) * 100 : cache[t].d1;
        updated++;
      });
    }
    localStorage.setItem('etf_perf_cache', JSON.stringify({ ts: Date.now(), data: cache }));
    renderEtfTables();
    if (st) st.textContent = `RT: ON | ${new Date().toLocaleTimeString('hr-HR')} | ${updated} tickera`;
  }

  window.stopEtfRealtime = function stopEtfRealtime(){
    if (etfRealtimeTimer) clearInterval(etfRealtimeTimer);
    etfRealtimeTimer = null;
    const st = document.getElementById('etfRtStatus');
    if (st) st.textContent = 'RT: OFF';
  };

  window.startEtfRealtime = function startEtfRealtime(){
    window.stopEtfRealtime();
    const sec = Math.max(5, parseInt(document.getElementById('etfRtSec')?.value || '15', 10));
    document.getElementById('etfRtSec').value = String(sec);
    refreshEtfRealtime().catch(e => setFetchStatus(`RT greška: ${e.message || e}`));
    etfRealtimeTimer = setInterval(() => refreshEtfRealtime().catch(e => setFetchStatus(`RT greška: ${e.message || e}`)), sec * 1000);
  };

  window.initEtfTracker = function initEtfTracker(){
    const sel = document.getElementById('etfProvider');
    if (!sel) return;
    sel.innerHTML = Object.entries(ETF_PROVIDERS).map(([k,v]) => `<option value="${k}">${v.name}</option>`).join('');
    sel.value = 'massive';
    localStorage.setItem('etf_provider', 'massive');
    const note = document.getElementById('etfProviderNote');
    if (note) note.textContent = 'ETF koristi backend proxy (Python) za Massive kako bi se izbjegao CORS. Pokreni app.py.';
    const keyInp = document.getElementById('etfApiKey');
    if (keyInp) keyInp.value = getMassiveKey();
    renderEtfTables();
  };

  window.onEtfProviderChange = function onEtfProviderChange(){
    localStorage.setItem('etf_provider', 'massive');
    const sel = document.getElementById('etfProvider');
    if (sel) sel.value = 'massive';
    const note = document.getElementById('etfProviderNote');
    if (note) note.textContent = 'Provider zaključan na Massive preko backend proxy-ja (bez CORS problema).';
  };

  window.saveEtfApiKey = function saveEtfApiKey(){
    const val = document.getElementById('etfApiKey')?.value?.trim();
    if (val) localStorage.setItem('etf_massive_key', val);
    else localStorage.removeItem('etf_massive_key');
    showToast('Spremljen Massive API key');
  };

  window.addEventListener('load', () => {
    try { window.initEtfTracker(); } catch(e) {}
  });
})();
