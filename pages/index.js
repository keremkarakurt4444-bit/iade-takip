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
  const scannerRef = useRef(null);
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
    return () => { try { if (window?.Quagga) window.Quagga.stop(); } catch {} };
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

  // Excel yükle
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
        const barcode = normalize(raw["BARKOD_NO"] || raw["BARKOD"] || "");
        if(!barcode) continue;
        upserts.push({
          barcode,
          isim: raw["ALICI_ISIM"] || "",
          telefon: raw["ALICI_TELEFON"] || "",
          added_at: new Date().toISOString()
        });
      }
    }
    const { error } = await supabaseRef.current.from("expected").upsert(upserts, { onConflict: "barcode" });
    if(error){ alert("Hata: " + error.message); return; }
    await refreshData();
  }

  // Eksikleri hesapla
  function computeMissing(){
    const recSet = new Set(received.map(r=> normalize(r.barcode)));
    return expected.filter(e => !recSet.has(normalize(e.barcode)));
  }

  // Excel dışa aktar
  function exportMissing(){
    const rows = computeMissing();
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Eksik");
    XLSX.writeFile(wb, "Eksik.xlsx");
  }
  function exportReceived(){
    const ws = XLSX.utils.json_to_sheet(received);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Gelen");
    XLSX.writeFile(wb, "Gelen.xlsx");
  }

  // Satır silme
  async function deleteExpected(barcode){
    await supabaseRef.current.from("expected").delete().eq("barcode", barcode);
    await refreshData();
  }
  async function deleteReceived(barcode){
    await supabaseRef.current.from("received").delete().eq("barcode", barcode);
    await refreshData();
  }

  // Hepsini temizle
  async function clearAll(){
    await supabaseRef.current.from("expected").delete().neq("barcode", "");
    await supabaseRef.current.from("received").delete().neq("barcode", "");
    await refreshData();
  }

  // Kamera okuma
  async function startScan(){
    if(!clientReady) return;
    if(typeof window === "undefined" || !window.Quagga) return;
    if(scanning) return;
    window.Quagga.init({
      inputStream: { type:"LiveStream", target: scannerRef.current, constraints:{ facingMode:"environment" } },
      decoder: { readers:["code_128_reader","ean_reader","ean_8_reader"] }
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
  function stopScan(){ try { window.Quagga.stop(); } catch{}; setScanning(false); }
  async function onScan(raw){
    const code = normalize(raw); if(!code) return;
    setLastCode(code);
    await supabaseRef.current.from("received").upsert({ barcode: code, added_at:new Date().toISOString() }, { onConflict:"barcode" });
    await refreshData();
  }
  function playBeep(){
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const osc = ctx.createOscillator(); osc.type="sine"; osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime+0.1);
  }

  return (
    <>
      <Head><title>İade Takip</title></Head>
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js" strategy="afterInteractive" />
      <div style={{padding:16,fontFamily:"system-ui"}}>
        <h1>📦 İade Takip</h1>
        <p><b>Durum:</b> {status}</p>
        <input type="file" accept=".xls,.xlsx" onChange={e=>handleExcel(e.target.files)} />
        <button onClick={exportMissing}>Eksikleri Excel</button>
        <button onClick={exportReceived}>Gelenleri Excel</button>
        <button onClick={clearAll}>🧹 Hepsini Temizle</button>

        <h3>📷 Barkod Okut</h3>
        <button onClick={startScan}>Başlat</button>
        <button onClick={stopScan}>Durdur</button>
        <div ref={scannerRef} style={{width:"100%",height:300,background:"#000"}} />
        <p>Son: {lastCode}</p>

        <h3>❌ Eksik İadeler</h3>
        <table border="1" cellPadding="4">
          <thead><tr><th>Barkod</th><th>İsim</th><th>Tel</th><th>Sil</th></tr></thead>
          <tbody>
            {computeMissing().map(m=>(
              <tr key={m.barcode}>
                <td>{m.barcode}</td><td>{m.isim}</td><td>{m.telefon}</td>
                <td><button onClick={()=>deleteExpected(m.barcode)}>Sil</button></td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>📥 Gelen İadeler</h3>
        <table border="1" cellPadding="4">
          <thead><tr><th>Barkod</th><th>Tarih</th><th>Sil</th></tr></thead>
          <tbody>
            {received.map(r=>(
              <tr key={r.barcode}>
                <td>{r.barcode}</td><td>{r.added_at}</td>
                <td><button onClick={()=>deleteReceived(r.barcode)}>Sil</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function normalize(s){ return String(s||"").replace(/\D+/g,"").replace(/^0+/,""); }
