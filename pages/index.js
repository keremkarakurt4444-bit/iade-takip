import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import Script from "next/script";
import * as XLSX from "xlsx";

export default function Home(){
  const [status, setStatus] = useState("Hazır");
  const [expected, setExpected] = useState([]);
  const [received, setReceived] = useState([]);
  const [lastCode, setLastCode] = useState("");
  const supabaseRef = useRef(null);
  const videoRef = useRef(null);
  const [scanning, setScanning] = useState(false);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Supabase sadece tarayıcıda çalışsın
  useEffect(()=>{
    if (typeof window === "undefined") return;
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
        const normKey = (k)=> String(k).trim().toUpperCase().replace(/\\s+/g,"_");
        const norm = {}; for(const [k,v] of Object.entries(raw)) norm[normKey(k)] = v;
        const barcode = normalize(norm["BARCODE"] ?? norm["BARKOD_NO"] ?? norm["BARKOD"] ?? "");
        if(!barcode) continue;
        const isim = (norm["ISIM"] ?? norm["ALICI_ISIM"] ?? "").toString();
        const telefon = (norm["TELEFON"] ?? "").toString();
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
    return expected.filter(e => !recSet.has(e.barcode));
  }

  return (
    <>
      <Head><title>İade Takip</title></Head>
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js" strategy="afterInteractive" />
      <div style={{maxWidth:1000, margin:"0 auto", padding:16, fontFamily:"system-ui"}}>
        <h1>📦 İade Takip</h1>
        <p><b>Durum:</b> {status}</p>

        <input type="file" accept=".xls,.xlsx" multiple onChange={(e)=>handleExcel(e.target.files)} />
        <button onClick={refreshData}>Yenile</button>

        <h3>Beklenen: {expected.length} | Gelen: {received.length} | Eksik: {computeMissing().length}</h3>
      </div>
    </>
  );
}

function normalize(s){
  if(s===null || s===undefined) return "";
  return String(s).trim().replace(/\\s+/g, "");
}
