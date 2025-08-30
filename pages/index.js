import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import Script from "next/script";
import * as XLSX from "xlsx";

export default function Home(){
  const [status, setStatus] = useState("Hazır");
  const [expected, setExpected] = useState([]);
  const [received, setReceived] = useState([]);
  const [lastCode, setLastCode] = useState("");
  const [clientReady, setClientReady] = useState(false);
  const supabaseRef = useRef(null);
  const videoRef = useRef(null);
  const [scanning, setScanning] = useState(false);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  useEffect(()=>{
    if (typeof window === "undefined") return;
    setClientReady(true);
    if (!url || !key) {
      setStatus("Supabase ayarları eksik: Vercel → Çevre Değişkenleri");
      return;
    }
    (async()=>{
      const { createClient } = await import("@supabase/supabase-js");
      supabaseRef.current = createClient(url, key);
      await refreshData();
    })();
  }, []);

  async function refreshData(){
    if (!supabaseRef.current) return;
    setStatus("Veriler çekiliyor...");
    const { data: exp } = await supabaseRef.current.from("expected").select("*");
    const { data: rec } = await supabaseRef.current.from("received").select("*");
    setExpected(exp || []);
    setReceived(rec || []);
    setStatus("Hazır");
  }

  async function handleExcel(fileList){
    if(!supabaseRef.current){ alert("Supabase ayarları eksik"); return; }
    if(!fileList || fileList.length===0){ alert("Excel seçin"); return; }
    setStatus("Excel okunuyor...");
    const upserts = [];
    for(const f of fileList){
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type:"array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval:"" });
      for(const raw of rows){
        const normKey = (k)=> String(k).trim().toUpperCase().replace(/\s+/g,"_");
        const norm = {}; for(const [k,v] of Object.entries(raw)) norm[normKey(k)] = v;
        const barcode = normalize(norm["BARCODE"] ?? norm["BARKOD_NO"] ?? norm["BARKOD"] ?? norm["MUS_BARKOD_NO"] ?? "");
        if(!barcode) continue;
        const isim = (norm["ISIM"] ?? norm["ALICI_ISIM"] ?? norm["ALICI"] ?? "").toString();
        const telefon = (norm["TELEFON"] ?? norm["ALICI_TELEFON"] ?? "").toString();
        upserts.push({ barcode, isim, telefon, added_at: new Date().toISOString() });
      }
    }
    if(upserts.length===0){ setStatus("Excel boş/uyumsuz"); return; }
    setStatus("Veritabanına yazılıyor...");
    const { error } = await supabaseRef.current.from("expected").upsert(upserts, { onConflict: "barcode" });
    if(error){ alert("Hata: " + error.message); setStatus("Hata"); return; }
    await refreshData();
  }

  function computeMissing(){
    const recSet = new Set(received.map(r=>r.barcode));
    const missing = expected.filter(e => !recSet.has(e.barcode));
    return missing.map(m=>{
      const days = m.added_at ? Math.floor((Date.now() - new Date(m.added_at).getTime()) / (24*3600*1000)) : "";
      return { ...m, days_pending: days };
    });
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

  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch {}
  }

  function startScan(){
    if(!clientReady){ alert("Tarayıcı hazır değil"); return; }
    if(typeof window === "undefined" || !window.Quagga){ alert("Tarama kütüphanesi yüklenmedi"); return; }
    if(scanning) return;
    setStatus("Kamera açılıyor...");
    const target = videoRef.current;
    window.Quagga.init({
      inputStream: { name:"Live", type:"LiveStream", target, constraints:{ facingMode:"environment" } },
      locator: { patchSize:"medium", halfSample:true },
      numOfWorkers: (navigator.hardwareConcurrency || 4),
      decoder: { readers:["code_128_reader","ean_reader","ean_8_reader","upc_reader","upc_e_reader"] },
      locate: true
    }, (err)=>{
      if(err){ setStatus("Kamera hatası"); return; }
      window.Quagga.start(); setScanning(true); setStatus("Tarama açık");
    });
    window.Quagga.onDetected(async res=>{
      const raw = res?.codeResult?.code || "";
      if(!raw) return;
      await onScan(raw);
      playBeep();
    });
  }

  function stopScan(){
    if(!scanning) return;
    window.Quagga.stop();
    setScanning(false);
    setStatus("Durduruldu");
  }

  async function onScan(raw){
    if(!supabaseRef.current){ return; }
    const code = normalize(raw);
    if(!code) return;
    setLastCode(code);
    const { error } = await supabaseRef.current
      .from("received")
      .upsert({ barcode: code, added_at: new Date().toISOString() }, { onConflict: "barcode" });
    if(error){ setStatus("Hata: " + error.message); return; }
    await refreshData();
    if(navigator.vibrate) navigator.vibrate(40);
  }

  const stats = useMemo(()=>{
    const list = computeMissing();
    return { expected: expected.length, received: received.length, missing: list.length, list };
  }, [expected, received]);

  return (
    <>
      <Head><title>İade Takip</title></Head>
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js" strategy="afterInteractive" />
      <div style={{maxWidth:1100, margin:"0 auto", padding:16, fontFamily:"system-ui"}}>
        <h1>📦 İade Takip</h1>
        <p><b>Durum:</b> {status}</p>

        <div style={{display:"flex", gap:12, flexWrap:"wrap", marginBottom:12}}>
          <input type="file" accept=".xls,.xlsx" multiple onChange={(e)=>handleExcel(e.target.files)} />
          <button onClick={exportMissing}>Eksikleri Excel&apos;e Aktar</button>
          <button onClick={refreshData}>Yenile</button>
        </div>

        <div style={{display:"grid", gridTemplateColumns:"2fr 1fr", gap:12}}>
          <div style={{border:"1px solid #e5e7eb", borderRadius:12, padding:12}}>
            <h3>📷 Kamera ile Barkod Okut</h3>
            <div style={{display:"flex", gap:8, marginBottom:8, alignItems:"center"}}>
              <button onClick={startScan}>Taramayı Başlat</button>
              <button onClick={stopScan}>Durdur</button>
              <span>Son: <code>{lastCode}</code></span>
            </div>
            <video ref={videoRef} style={{width:"100%", background:"#000", borderRadius:8}} />
          </div>

          <div style={{border:"1px solid #e5e7eb", borderRadius:12, padding:12}}>
            <h3>📊 Durum</h3>
            <p>Beklenen: {stats.expected} | Gelen: {stats.received} | Eksik: {stats.missing}</p>
          </div>
        </div>

        <div style={{marginTop:12, border:"1px solid #e5e7eb", borderRadius:12, padding:12}}>
          <h3>❌ Eksik İadeler</h3>
          <table style={{width:"100%", borderCollapse:"collapse"}}>
            <thead>
              <tr>
                <th style={{borderBottom:"1px solid #ccc", padding:8}}>BARKOD_NO</th>
                <th style={{borderBottom:"1px solid #ccc", padding:8}}>ALICI_ISIM</th>
                <th style={{borderBottom:"1px solid #ccc", padding:8}}>ALICI_TELEFON</th>
                <th style={{borderBottom:"1px solid #ccc", padding:8}}>Kaç Gün</th>
                <th style={{borderBottom:"1px solid #ccc", padding:8}}>İlk Yükleme</th>
              </tr>
            </thead>
            <tbody>
              {stats.list.map(m=>(
                <tr key={m.barcode}>
                  <td style={{borderBottom:"1px solid #eee", padding:8}}>{m.barcode}</td>
                  <td style={{borderBottom:"1px solid #eee", padding:8}}>{m.isim}</td>
                  <td style={{borderBottom:"1px solid #eee", padding:8}}>{m.telefon}</td>
                  <td style={{borderBottom:"1px solid #eee", padding:8}}>{m.days_pending}</td>
                  <td style={{borderBottom:"1px solid #eee", padding:8}}>{humanDate(m.added_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function normalize(s){ return (s??"").toString().trim(); }
function humanDate(iso){ if(!iso) return ""; try { return new Date(iso).toLocaleString(); } catch { return iso; } }
