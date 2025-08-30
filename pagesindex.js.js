import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import Script from "next/script";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export default function Home(){
  const [status, setStatus] = useState("Hazır");
  const [expected, setExpected] = useState([]);   // {barcode, isim, telefon, added_at}
  const [received, setReceived] = useState([]);   // {barcode, received_at}
  const [lastCode, setLastCode] = useState("");
  const videoRef = useRef(null);
  const [scanning, setScanning] = useState(false);

  // Fetch data initially
  useEffect(()=>{
    (async()=>{
      await refreshData();
    })();
  },[]);

  async function refreshData(){
    setStatus("Veriler çekiliyor...");
    const { data: exp, error: e1 } = await supabase.from("expected").select("*");
    const { data: rec, error: e2 } = await supabase.from("received").select("*");
    if(e1) console.error(e1);
    if(e2) console.error(e2);
    setExpected(exp || []);
    setReceived(rec || []);
    setStatus("Hazır");
  }

  // Excel import -> upsert expected
  async function handleExcel(files){
    if(!files || files.length===0){ alert("Excel seçin"); return; }
    setStatus("Excel okunuyor...");
    const upserts = [];
    for(const f of files){
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type:"array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval:"" });
      for(const raw of rows){
        // normalize headers
        const normKey = (k)=> String(k).trim().toUpperCase().replace(/\s+/g,"_");
        const norm = {}; for(const [k,v] of Object.entries(raw)) norm[normKey(k)] = v;
        const barcode = normalize(norm["BARCODE"] ?? norm["BARKOD_NO"] ?? norm["BARKOD"] ?? norm["MUS_BARKOD_NO"] ?? "");
        if(!barcode) continue;
        const isim = (norm["ISIM"] ?? norm["ALICI_ISIM"] ?? norm["ALICI"] ?? norm["MUSTERI_ADI"] ?? "").toString();
        const telefon = (norm["TELEFON"] ?? norm["ALICI_TELEFON"] ?? norm["GSM"] ?? "").toString();
        upserts.push({ barcode, isim, telefon, added_at: new Date().toISOString() });
      }
    }
    if(upserts.length===0){ setStatus("Excel boş/uyumsuz"); return; }
    setStatus("Veritabanına yazılıyor...");
    // upsert by barcode
    const { error } = await supabase.from("expected").upsert(upserts, { onConflict: "barcode" });
    if(error){ console.error(error); alert("Hata: " + error.message); setStatus("Hata"); return; }
    await refreshData();
  }

  function computeMissing(){
    const recSet = new Set(received.map(r=>r.barcode));
    const missing = expected.filter(e => !recSet.has(e.barcode));
    // add days pending
    return missing.map(m=>{
      const days = m.added_at ? Math.floor((Date.now() - new Date(m.added_at).getTime()) / (24*3600*1000)) : "";
      return { ...m, days_pending: days };
    }).sort((a,b)=> (b.days_pending||0) - (a.days_pending||0));
  }

  function exportMissing(){
    const rows = computeMissing().map(m => ({
      BARKOD_NO: m.barcode,
      ALICI_ISIM: m.isim || "",
      ALICI_TELEFON: m.telefon || "",
      KAC_GUNDUR_GELMEDI: m.days_pending,
      ILK_YUKLEME_TARIHI: humanDate(m.added_at),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "EksikIadeler");
    XLSX.writeFile(wb, `Eksik_Iadeler_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  // Barcode via Quagga (script via CDN)
  function startScan(){
    if(typeof window === "undefined" || !window.Quagga){ alert("Tarayıcı tarama kütüphanesi yüklenmedi"); return; }
    if(scanning) return;
    setStatus("Kamera açılıyor...");
    const target = videoRef.current;
    window.Quagga.init({
      inputStream: { name:"Live", type:"LiveStream", target, constraints:{ facingMode:"environment", aspectRatio:{ min: 1, max: 2 } } },
      locator: { patchSize:"medium", halfSample:true },
      numOfWorkers: (navigator.hardwareConcurrency || 4),
      decoder: { readers:["code_128_reader","code_39_reader","ean_reader","ean_8_reader","upc_reader","upc_e_reader"] },
      locate: true
    }, (err)=>{
      if(err){ console.error(err); setStatus("Kamera hatası"); return; }
      window.Quagga.start(); setScanning(true); setStatus("Tarama açık");
    });
    window.Quagga.onDetected(async res=>{
      const code = res?.codeResult?.code || null;
      if(code) await onScan(code);
    });
  }
  function stopScan(){
    if(!scanning) return;
    window.Quagga.stop();
    setScanning(false);
    setStatus("Durduruldu");
  }

  async function onScan(raw){
    const code = normalize(raw);
    if(!code) return;
    setLastCode(code);
    const { error } = await supabase.from("received").upsert({ barcode: code, received_at: new Date().toISOString() }, { onConflict: "barcode" });
    if(error){ console.error(error); setStatus("Hata: "+error.message); return; }
    await refreshData();
    if(navigator.vibrate) navigator.vibrate(50);
  }

  const stats = useMemo(()=>{
    const miss = computeMissing();
    return {
      expected: expected.length,
      received: received.length,
      missing: miss.length,
      list: miss
    }
  }, [expected, received]);

  return (
    <>
      <Head>
        <title>İade Takip</title>
      </Head>
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js" strategy="afterInteractive" />
      <div style={{maxWidth:1100, margin:"0 auto", padding:16, fontFamily:"system-ui"}}>
        <h1>📦 İade Takip</h1>
        <p style={{color:"#64748b"}}>Excel yükle → beklenenleri ekle. Telefonda kameradan okut → gelenler eklenir. Eksikleri indir.</p>
        <p><b>Durum:</b> {status}</p>

        <div style={{display:"flex", gap:12, flexWrap:"wrap", marginBottom:12}}>
          <input type="file" accept=".xls,.xlsx" multiple onChange={(e)=>handleExcel(e.target.files)} />
          <button onClick={exportMissing}>Eksikleri Excel'e Aktar</button>
          <button onClick={refreshData}>Yenile</button>
        </div>

        <div style={{display:"grid", gridTemplateColumns:"2fr 1fr", gap:12}}>
          <div style={{border:"1px solid #e5e7eb", borderRadius:12, padding:12}}>
            <h3>📷 Kamera ile Barkod Okut</h3>
            <div style={{display:"flex", gap:8, marginBottom:8}}>
              <button onClick={startScan}>Taramayı Başlat</button>
              <button onClick={stopScan}>Durdur</button>
              <span>Son: <code>{lastCode}</code></span>
            </div>
            <video ref={videoRef} style={{width:"100%", background:"#000", borderRadius:8}} />
            <div style={{marginTop:8}}>
              <input placeholder="Manuel barkod" onKeyDown={(e)=>{ if(e.key==='Enter'){ onScan(e.currentTarget.value); e.currentTarget.value=''; }}} />
              <button onClick={()=>{
                const el = document.querySelector("input[placeholder='Manuel barkod']");
                if(el && el.value){ onScan(el.value); el.value=''; }
              }}>Ekle</button>
            </div>
          </div>

          <div style={{border:"1px solid #e5e7eb", borderRadius:12, padding:12}}>
            <h3>📊 Durum</h3>
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8}}>
              <div style={{border:"1px solid #e5e7eb", borderRadius:12, padding:12, textAlign:"center"}}>
                <div>Beklenen</div><div style={{fontSize:24, fontWeight:800}}>{stats.expected}</div>
              </div>
              <div style={{border:"1px solid #e5e7eb", borderRadius:12, padding:12, textAlign:"center"}}>
                <div>Gelen</div><div style={{fontSize:24, fontWeight:800, color:"#16a34a"}}>{stats.received}</div>
              </div>
              <div style={{border:"1px solid #e5e7eb", borderRadius:12, padding:12, textAlign:"center"}}>
                <div>Eksik</div><div style={{fontSize:24, fontWeight:800, color:"#ef4444"}}>{stats.missing}</div>
              </div>
            </div>
          </div>
        </div>

        <div style={{marginTop:12, border:"1px solid #e5e7eb", borderRadius:12, padding:12}}>
          <h3>❌ Eksik İadeler</h3>
          <div style={{overflow:"auto"}}>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr>
                  <th style={{borderBottom:"1px solid #e5e7eb", textAlign:"left", padding:8}}>BARKOD_NO</th>
                  <th style={{borderBottom:"1px solid #e5e7eb", textAlign:"left", padding:8}}>ALICI_ISIM</th>
                  <th style={{borderBottom:"1px solid #e5e7eb", textAlign:"left", padding:8}}>ALICI_TELEFON</th>
                  <th style={{borderBottom:"1px solid #e5e7eb", textAlign:"right", padding:8}}>Kaç Gündür Gelmedi</th>
                  <th style={{borderBottom:"1px solid #e5e7eb", textAlign:"right", padding:8}}>İlk Yükleme</th>
                </tr>
              </thead>
              <tbody>
                {stats.list.map((m)=>(
                  <tr key={m.barcode}>
                    <td style={{borderBottom:"1px solid #f1f5f9", padding:8}}><code>{m.barcode}</code></td>
                    <td style={{borderBottom:"1px solid #f1f5f9", padding:8}}>{m.isim}</td>
                    <td style={{borderBottom:"1px solid #f1f5f9", padding:8}}><code>{m.telefon}</code></td>
                    <td style={{borderBottom:"1px solid #f1f5f9", padding:8, textAlign:"right"}}>{m.days_pending}</td>
                    <td style={{borderBottom:"1px solid #f1f5f9", padding:8, textAlign:"right"}}>{humanDate(m.added_at)}</td>
                  </tr>
                ))}
                {stats.list.length===0 && (
                  <tr><td colSpan={5} style={{padding:12, color:"#64748b"}}>Eksik iade yok 🎉</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function normalize(s){
  if(s===null || s===undefined) return "";
  return String(s).trim().replace(/\s+/g, "");
}
function humanDate(iso){
  if(!iso) return "";
  try{
    return new Date(iso).toLocaleString();
  }catch{ return iso; }
}
