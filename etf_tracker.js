(function(){
  let etfRealtimeTimer = null;
  let etfSortCol = 'ytd';
  let etfSortDir = -1;
  let etfFilter = 'all';
  let backendOk = null;

  const COUNTRY = () => (window.ETF_COUNTRY_LIST || []);
  const THEME = () => (window.ETF_THEME_LIST || []);

  function getKey(){ return localStorage.getItem('etf_massive_key') || ''; }
  function setStatus(msg, err=false){ const e=document.getElementById('etfFetchStatus'); if(e){e.textContent=msg||''; e.style.color=err?'var(--red)':'var(--text-dim)';} }
  function getCacheObj(){ try{return JSON.parse(localStorage.getItem('etf_perf_cache')||'{}')}catch(e){return {}} }
  function getCache(){ return getCacheObj().data || {}; }
  function setCache(data){ localStorage.setItem('etf_perf_cache', JSON.stringify({ts:Date.now(), data})); }
  function getWatch(){ try{return JSON.parse(localStorage.getItem('etf_watchlist')||'[]')}catch(e){return []} }

  function updateProgress(done,total,ok,fail){
    const wrap=document.getElementById('etfProgressWrap');
    const fill=document.getElementById('etfProgressFill');
    const txt=document.getElementById('etfProgressTxt');
    if (!wrap || !fill || !txt) return;
    wrap.style.display = done>=total ? 'none' : 'block';
    fill.style.width = `${total? (done/total*100):0}%`;
    txt.textContent = `${done}/${total} · ${ok} OK · ${fail} greška`;
  }

  async function checkBackend(){
    try{
      const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(), 3000);
      const r=await fetch('/api/health',{signal:ctrl.signal});
      backendOk = !!r.ok;
    }catch(e){ backendOk=false; }
    const el=document.getElementById('etfBackendStatus');
    if(el) el.textContent = backendOk ? 'Backend: app.py aktivan (proxy bez CORS)' : 'Backend: offline, fallback na javne izvore';
    return backendOk;
  }

  function calcPerf(series){
    if(!series || series.length<60) return null;
    const s=[...series].sort((a,b)=>a.date.localeCompare(b.date));
    const n=s.length, last=s[n-1].close, prev=s[n-2]?.close;
    const pick=d=>s[Math.max(0,n-d-1)]?.close;
    const yStart=s.find(x=>x.date>=`${new Date().getFullYear()}-01-01`)?.close || s[0].close;
    const ret=b=>b? ((last-b)/Math.abs(b))*100 : null;
    const ma=d=>{ const seg=s.slice(Math.max(0,n-d)); return seg.length?seg.reduce((a,b)=>a+b.close,0)/seg.length:null; };
    const maPrev=(d,o=10)=>{ const e=Math.max(0,n-o); const seg=s.slice(Math.max(0,e-d),e); return seg.length?seg.reduce((a,b)=>a+b.close,0)/seg.length:null; };
    const ma50=ma(50), ma150=ma(150), ma200=ma(200);
    const s150=(ma150&&maPrev(150))?((ma150-maPrev(150))/Math.abs(maPrev(150)))*100:null;
    let stage='Stage 1 (Baza)';
    if(ma150 && s150!=null){
      if(last>ma150 && s150>0.1 && ma50 && ma50>ma150) stage='Stage 2 (Uzlazni)';
      else if(last<ma150 && s150<-0.1 && ma50 && ma50<ma150) stage='Stage 4 (Silazni)';
      else if(last>ma150) stage='Stage 3 (Vrhunac)';
    }
    let rsi=null;
    if(n>=15){ const rec=s.slice(-15); let g=0,l=0; for(let i=1;i<rec.length;i++){ const d=rec[i].close-rec[i-1].close; if(d>0)g+=d; else l-=d; } const ag=g/14, al=l/14; rsi = al===0?100:Math.round(100-100/(1+ag/al)); }
    const y1=s.slice(Math.max(0,n-252));
    const hi52=Math.max(...y1.map(x=>x.close)), lo52=Math.min(...y1.map(x=>x.close));
    return { price:last, d1:ret(prev), w1:ret(pick(5)), m1:ret(pick(21)), ytd:ret(yStart), y1:ret(pick(252)), rsi, stage, ma200, pctFromHi:((last-hi52)/hi52)*100, hi52, lo52, aboveMa200: ma200? last>ma200:null };
  }

  async function fetchViaBackend(t){
    const key=getKey(); if(!key) throw new Error('Nedostaje Massive key');
    const r=await fetch(`/api/etf/history?ticker=${encodeURIComponent(t)}&years=3&apiKey=${encodeURIComponent(key)}`);
    const d=await r.json(); if(!r.ok) throw new Error(d.error||'backend fail');
    if(!d.results?.length) throw new Error('backend no results');
    return d.results;
  }

  async function fetchDirectPolygon(t){
    const key=getKey(); if(!key) throw new Error('Nedostaje Massive key');
    const to=new Date().toISOString().slice(0,10);
    const from=new Date(Date.now()-3*365*86400000).toISOString().slice(0,10);
    const u=`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(key)}`;
    const r=await fetch(u); if(!r.ok) throw new Error(`Polygon ${r.status}`);
    const d=await r.json();
    const rows=(d.results||[]).map(x=>({date:new Date(x.t).toISOString().slice(0,10), close:x.c})).filter(x=>x.date && Number.isFinite(x.close));
    if(!rows.length) throw new Error('Polygon no results');
    return rows;
  }

  async function fetchYahoo(t){
    const raw=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=3y&interval=1d`;
    const proxies=[`https://corsproxy.io/?url=${encodeURIComponent(raw)}`,`https://api.allorigins.win/raw?url=${encodeURIComponent(raw)}`];
    for(const u of proxies){ try{ const r=await fetch(u); if(!r.ok) continue; const d=await r.json(); const res=d?.chart?.result?.[0]; if(!res?.timestamp?.length) continue; const c=res.indicators?.quote?.[0]?.close||[]; const rows=res.timestamp.map((x,i)=>({date:new Date(x*1000).toISOString().slice(0,10),close:c[i]})).filter(x=>x.date&&Number.isFinite(x.close)); if(rows.length>20) return rows; }catch(e){} }
    throw new Error('Yahoo unavailable');
  }

  async function fetchStooq(t){
    const raw=`https://stooq.com/q/d/l/?s=${encodeURIComponent(t.toLowerCase()+'.us')}&i=d`;
    const proxies=[`https://corsproxy.io/?url=${encodeURIComponent(raw)}`,`https://api.allorigins.win/raw?url=${encodeURIComponent(raw)}`];
    for(const u of proxies){ try{ const r=await fetch(u); if(!r.ok) continue; const csv=await r.text(); if(!csv||csv.startsWith('No data')) continue; const rows=csv.trim().split(/\r?\n/).slice(1).map(l=>{const p=l.split(','); return {date:(p[0]||'').trim(),close:parseFloat(p[4])};}).filter(x=>x.date&&Number.isFinite(x.close)); if(rows.length>10) return rows; }catch(e){} }
    throw new Error('Stooq unavailable');
  }

  async function fetchSeries(t){
    const errs=[];
    if (backendOk && getKey()) { try { return await fetchViaBackend(t); } catch(e){ errs.push(`backend:${e.message}`);} }
    if (getKey()) { try { return await fetchDirectPolygon(t); } catch(e){ errs.push(`polygon:${e.message}`);} }
    try { return await fetchYahoo(t);} catch(e){ errs.push(`yahoo:${e.message}`);} 
    try { return await fetchStooq(t);} catch(e){ errs.push(`stooq:${e.message}`);} 
    throw new Error(errs.slice(0,2).join(' | '));
  }

  function pctClass(v){ if(v==null||Number.isNaN(v)) return 'val-zero'; if(v>=3) return 'val-pos2'; if(v>0) return 'val-pos1'; if(v<=-3) return 'val-neg2'; return 'val-neg1'; }
  function fmtPct(v){ return v==null||Number.isNaN(v)?'—':`${v>=0?'+':''}${v.toFixed(2)}%`; }

  function passFilter(t,p){ const w=new Set(getWatch());
    if(etfFilter==='s2') return p?.stage?.includes('2');
    if(etfFilter==='s3') return p?.stage?.includes('3');
    if(etfFilter==='s4') return p?.stage?.includes('4');
    if(etfFilter==='aboveMa200') return p?.aboveMa200===true;
    if(etfFilter==='oversold') return p?.rsi!=null && p.rsi<=30;
    if(etfFilter==='watch') return w.has(t);
    return true;
  }

  function sortItems(items,cache){
    return [...items].sort((a,b)=>{
      const pa=cache[a.ticker]||{}, pb=cache[b.ticker]||{};
      if(etfSortCol==='ticker') return etfSortDir*a.ticker.localeCompare(b.ticker);
      if(etfSortCol==='name') return etfSortDir*a.name.localeCompare(b.name);
      if(etfSortCol==='stage') return etfSortDir*String(pa.stage||'').localeCompare(String(pb.stage||''));
      const va=pa[etfSortCol], vb=pb[etfSortCol];
      if(va==null && vb==null) return 0;
      if(va==null) return 1; if(vb==null) return -1;
      return etfSortDir*(va-vb);
    });
  }

  function renderStats(cache){
    const vals=Object.values(cache).filter(Boolean);
    const s2=vals.filter(p=>p.stage?.includes('2')).length;
    const s4=vals.filter(p=>p.stage?.includes('4')).length;
    const set=(id,v)=>{const e=document.getElementById(id); if(e) e.textContent=v;};
    set('etfStTotal', vals.length); set('etfStS2', s2); set('etfStS4', s4);
    const ts=getCacheObj().ts; if(ts){ const age=Math.round((Date.now()-ts)/60000); set('etfStCache', age<60?`${age} min`:`${Math.round(age/60)} h`); }
  }

  function renderScanner(cache){
    const all=[...COUNTRY().map(x=>({ticker:x.ticker,name:x.name})),...THEME().map(x=>({ticker:x.ticker,name:x.name}))];
    const withData=all.filter(x=>cache[x.ticker]);
    const topS2=withData.filter(x=>cache[x.ticker].stage?.includes('2')).sort((a,b)=>(cache[b.ticker].ytd||-999)-(cache[a.ticker].ytd||-999)).slice(0,8);
    const topYtd=[...withData].sort((a,b)=>(cache[b.ticker].ytd||-999)-(cache[a.ticker].ytd||-999)).slice(0,8);
    const oversold=withData.filter(x=>cache[x.ticker].rsi!=null&&cache[x.ticker].rsi<=35).sort((a,b)=>(cache[a.ticker].rsi||999)-(cache[b.ticker].rsi||999)).slice(0,8);
    const row=(x,key)=>`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(30,42,56,.4)"><span class="mono" style="font-size:12px;color:var(--amber);cursor:pointer" onclick="showEtfModal('${x.ticker}')">${x.ticker}</span><span class="${key==='rsi'?'val-zero':pctClass(cache[x.ticker][key])}">${key==='rsi'?cache[x.ticker].rsi:fmtPct(cache[x.ticker][key])}</span></div>`;
    const grid=document.getElementById('etfScannerGrid'); if(!grid) return;
    grid.innerHTML=`
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:10px"><div class="mono" style="font-size:10px;color:var(--green);margin-bottom:6px">Stage 2 lideri</div>${topS2.length?topS2.map(x=>row(x,'ytd')).join(''):'<div class="text-dim">Nema</div>'}</div>
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:10px"><div class="mono" style="font-size:10px;color:var(--amber);margin-bottom:6px">Top YTD</div>${topYtd.length?topYtd.map(x=>row(x,'ytd')).join(''):'<div class="text-dim">Nema</div>'}</div>
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:10px"><div class="mono" style="font-size:10px;color:var(--blue);margin-bottom:6px">RSI oversold</div>${oversold.length?oversold.map(x=>row(x,'rsi')).join(''):'<div class="text-dim">Nema</div>'}</div>
    `;
  }

  function renderWatch(){ const w=getWatch(); const el=document.getElementById('etfWatchlist'); if(el) el.textContent=w.length?w.join(', '):'Nema odabranih ETF-ova.'; }

  function renderTables(){
    const watch=new Set(getWatch()), cache=getCache();
    const cb=document.getElementById('etfCountryBody'), tb=document.getElementById('etfThemeBody');
    if(!cb||!tb) return;
    const cItems=sortItems(COUNTRY(),cache).filter(i=>passFilter(i.ticker, cache[i.ticker]));
    const tItems=sortItems(THEME(),cache).filter(i=>passFilter(i.ticker, cache[i.ticker]));

    cb.innerHTML=cItems.map(i=>{ const p=cache[i.ticker]||{}; const st=p.stage||'—';
      return `<tr class="${st.includes('2')?'signal-row':''}"><td style="cursor:pointer" onclick="showEtfModal('${i.ticker}')">${i.name}</td><td>${i.ticker}</td><td style="text-align:left">${i.country}</td><td>${p.price?`$${p.price.toFixed(2)}`:'—'}</td><td class="${st.includes('2')?'val-pos2':st.includes('4')?'val-neg2':'val-zero'}">${st}</td><td class="${p.rsi>=70?'val-neg1':p.rsi<=30?'val-pos1':'val-zero'}">${p.rsi??'—'}</td><td class="${pctClass(p.d1)}">${fmtPct(p.d1)}</td><td class="${pctClass(p.w1)}">${fmtPct(p.w1)}</td><td class="${pctClass(p.m1)}">${fmtPct(p.m1)}</td><td class="${pctClass(p.ytd)}">${fmtPct(p.ytd)}</td><td class="${pctClass(p.y1)}">${fmtPct(p.y1)}</td><td><button class="btn btn-secondary btn-sm" onclick="toggleEtfWatch('${i.ticker}')">${watch.has(i.ticker)?'★':'☆'}</button></td></tr>`;
    }).join('') || '<tr><td colspan="12" class="empty-state">Nema ETF-ova za filter.</td></tr>';

    tb.innerHTML=tItems.map(i=>{ const p=cache[i.ticker]||{}; const st=p.stage||'—';
      return `<tr><td style="text-align:left;color:var(--cyan)">${i.theme}</td><td style="text-align:left;cursor:pointer" onclick="showEtfModal('${i.ticker}')">${i.name}</td><td>${i.ticker}</td><td>${p.price?`$${p.price.toFixed(2)}`:'—'}</td><td class="${st.includes('2')?'val-pos2':st.includes('4')?'val-neg2':'val-zero'}">${st}</td><td class="${p.rsi>=70?'val-neg1':p.rsi<=30?'val-pos1':'val-zero'}">${p.rsi??'—'}</td><td class="${pctClass(p.d1)}">${fmtPct(p.d1)}</td><td class="${pctClass(p.w1)}">${fmtPct(p.w1)}</td><td class="${pctClass(p.m1)}">${fmtPct(p.m1)}</td><td class="${pctClass(p.ytd)}">${fmtPct(p.ytd)}</td><td class="${pctClass(p.y1)}">${fmtPct(p.y1)}</td><td><button class="btn btn-secondary btn-sm" onclick="toggleEtfWatch('${i.ticker}')">${watch.has(i.ticker)?'★':'☆'}</button></td></tr>`;
    }).join('') || '<tr><td colspan="12" class="empty-state">Nema ETF-ova za filter.</td></tr>';

    renderWatch(); renderStats(cache); renderScanner(cache);
  }


  window.renderEtfTables = function(){ renderTables(); };
  window.toggleEtfWatch = function(t){ const s=new Set(getWatch()); if(s.has(t)) s.delete(t); else s.add(t); localStorage.setItem('etf_watchlist', JSON.stringify([...s])); renderTables(); }
  window.setEtfSort = function(col){ if(etfSortCol===col) etfSortDir*=-1; else {etfSortCol=col; etfSortDir=-1;} renderTables(); }
  window.setEtfFilter = function(f,btn){ etfFilter=f; document.querySelectorAll('#etfFilterTabs .period-tab').forEach(x=>x.classList.remove('active')); if(btn) btn.classList.add('active'); renderTables(); }

  window.showEtfModal = function(t){
    const cache=getCache(); const p=cache[t]; const m=document.getElementById('etfModal'); const c=document.getElementById('etfModalContent'); if(!m||!c) return;
    if(!p){ c.innerHTML=`<div class="empty-state">Nema podataka za ${t}.</div>`; m.style.display='flex'; return; }
    c.innerHTML=`<h2 class="mono" style="color:var(--amber);margin-bottom:4px">${t}</h2><div class="text-dim" style="margin-bottom:10px">Cijena: ${p.price?`$${p.price.toFixed(2)}`:'—'} · ${p.stage||'—'} · RSI ${p.rsi??'—'}</div>
    <div class="table-wrapper"><table><tbody>
      <tr><td>1D</td><td class="${pctClass(p.d1)}">${fmtPct(p.d1)}</td></tr>
      <tr><td>1W</td><td class="${pctClass(p.w1)}">${fmtPct(p.w1)}</td></tr>
      <tr><td>1M</td><td class="${pctClass(p.m1)}">${fmtPct(p.m1)}</td></tr>
      <tr><td>YTD</td><td class="${pctClass(p.ytd)}">${fmtPct(p.ytd)}</td></tr>
      <tr><td>1Y</td><td class="${pctClass(p.y1)}">${fmtPct(p.y1)}</td></tr>
      <tr><td>52W High</td><td>${p.hi52?`$${p.hi52.toFixed(2)}`:'—'}</td></tr>
      <tr><td>52W Low</td><td>${p.lo52?`$${p.lo52.toFixed(2)}`:'—'}</td></tr>
      <tr><td>od 52W High</td><td>${p.pctFromHi!=null?`${p.pctFromHi.toFixed(1)}%`:'—'}</td></tr>
    </tbody></table></div>`;
    m.style.display='flex';
  }
  window.closeEtfModal = function(){ const m=document.getElementById('etfModal'); if(m) m.style.display='none'; }

  window.refreshEtfData = async function(){
    const btn=document.getElementById('etfRefreshBtn'); if(btn){btn.disabled=true; btn.textContent='⏳ Osvježavam...';}
    await checkBackend();
    const all=[...COUNTRY(),...THEME()]; const dedup=[]; const seen=new Set(); all.forEach(x=>{ if(!seen.has(x.ticker)){seen.add(x.ticker); dedup.push(x);} });
    const cache={...getCache()}; let done=0, ok=0, fail=0; const failed=[]; updateProgress(0,dedup.length,0,0);
    for(let i=0;i<dedup.length;i+=6){
      const batch=dedup.slice(i,i+6);
      await Promise.allSettled(batch.map(async (item)=>{
        try{ const series=await fetchSeries(item.ticker); cache[item.ticker]=calcPerf(series); ok++; }
        catch(e){ fail++; failed.push(`${item.ticker}: ${e.message||'greška'}`); }
        done++; updateProgress(done,dedup.length,ok,fail);
      }));
      setCache(cache); renderTables();
    }
    setStatus(fail?`${ok} OK · ${fail} grešaka${failed.length?` | ${failed.slice(0,4).join(', ')}`:''}`:`✓ ${ok} ETF-ova dohvaćeno`, fail>ok*0.5);
    showToast(`ETF osvježeno: ${ok} OK, ${fail} grešaka`, fail>ok*0.5);
    if(btn){btn.disabled=false; btn.textContent='Osvježi EOD';}
  }

  async function doRT(){
    if(!backendOk){ setStatus('Realtime treba app.py backend', true); return; }
    if(!getKey()){ setStatus('Realtime treba Massive key', true); return; }
    const tickers=[...new Set([...COUNTRY().map(x=>x.ticker),...THEME().map(x=>x.ticker)])];
    const cache={...getCache()}; let updated=0;
    for(let i=0;i<tickers.length;i+=40){
      const chunk=tickers.slice(i,i+40);
      try{ const r=await fetch(`/api/etf/snapshot?tickers=${encodeURIComponent(chunk.join(','))}&apiKey=${encodeURIComponent(getKey())}`); const d=await r.json(); (d.tickers||[]).forEach(row=>{ const price=row?.day?.c, prev=row?.prevDay?.c; if(!Number.isFinite(price)) return; if(!cache[row.ticker]) cache[row.ticker]={}; cache[row.ticker].price=price; if(Number.isFinite(prev)&&prev) cache[row.ticker].d1=((price-prev)/prev)*100; updated++; }); }
      catch(e){}
    }
    setCache(cache); renderTables();
    const st=document.getElementById('etfRtStatus'); if(st) st.textContent=`RT: ON · ${new Date().toLocaleTimeString('hr-HR')} · ${updated} ažurirano`;
  }

  window.startEtfRealtime = function(){ stopEtfRealtime(); const sec=Math.max(5, parseInt(document.getElementById('etfRtSec')?.value||'15',10)); doRT(); etfRealtimeTimer=setInterval(doRT, sec*1000); }
  window.stopEtfRealtime = function(){ if(etfRealtimeTimer) clearInterval(etfRealtimeTimer); etfRealtimeTimer=null; const st=document.getElementById('etfRtStatus'); if(st) st.textContent='RT: OFF'; }

  window.saveEtfApiKey = function(){ const v=document.getElementById('etfApiKey')?.value?.trim(); if(v) localStorage.setItem('etf_massive_key',v); else localStorage.removeItem('etf_massive_key'); showToast(v?'Massive key spremljen':'Massive key obrisan'); }
  window.onEtfProviderChange = function(){ localStorage.setItem('etf_provider','massive'); const sel=document.getElementById('etfProvider'); if(sel) sel.value='massive'; }
  window.initEtfTracker = async function(){
    const sel=document.getElementById('etfProvider'); if(!sel) return;
    sel.innerHTML='<option value="massive">Massive / Polygon.io (proxy)</option><option value="yahoo">Yahoo fallback</option><option value="stooq">Stooq fallback</option>';
    const saved=localStorage.getItem('etf_provider')||'massive'; sel.value=saved;
    const key=document.getElementById('etfApiKey'); if(key) key.value=getKey();
    const note=document.getElementById('etfProviderNote'); if(note) note.textContent='Massive ide preko app.py backend proxy-ja (bez CORS). Ako backend padne, fallback ide na Yahoo/Stooq proxije.';
    await checkBackend();
    renderTables();
    const c=getCacheObj(); const has=Object.values(c.data||{}).some(Boolean); const age=c.ts?Date.now()-c.ts:Infinity;
    if(!has || age>4*3600*1000) setTimeout(()=>window.refreshEtfData(), 350);
  }
})();
