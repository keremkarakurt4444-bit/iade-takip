import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import Script from "next/script";
import * as XLSX from "xlsx";

export default function Home(){
  const [status, setStatus] = useState("Hazır");
  const [expected, setExpected] = useState([]);   // beklenen iadeler
  const [received, setReceived] = useState([]);   // gelen iadeler
  const [lastCode, setLastCode] = useState("");
  const [clientReady, setClientReady] = useState(false);

  const supabaseRef = useRef(null);
  const scannerRef = useRef(null); // Quagga önizleme buraya çizilecek
  const [scanning, setScanning] = useState(false);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Tarayıcıda Supabase'i başlat
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

    // sayfa değişince kamerayı kapat
    return () => {
      try { if (window?.Quagga) { window.Quagga.stop(); } } catch {}
    };
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

  // Excel yükle → expected'e yaz
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
        if(!barcode) continue; // barkodsuz satırları at
        const isim = (norm["ISIM"] ?? norm["ALICI_ISIM"] ?? norm["ALICI"] ?? norm["MUSTERI_ADI"] ?? "").toString();
        const telefon = (norm["TELEFON"] ?? norm["ALICI_TELEFON"] ?? norm["GSM"] ?? "").toString();
        upserts.push({ barcode, isim, telefon, added_at: new Date().toISOString() });
      }
    }
    if(upserts.length===0){ setStatus("Excel boş/uyumsuz"); return; }
    setStatus("Veritabanına yazılıyor...");
    const { error } = await supabaseRef.current.from("expected").upsert(upserts, { onConflict: "barcode" });
    if(error){ alert("Hata: " + error.message); setStatus("Hata"); return; }
    await refreshData();
  }

  // Eksikleri hesapla + kaç gündür gelmedi
  function computeMissing(){
    const recSet = new Set(received.map(r=>r.barcode));
    const missing = expected.filter(e => !recSet.has(e.barcode));
    return missing.map(m=>{
      const days = m.added_at ? Math.floor((Date.now() - new Date(m.added_at).getTime()) / (24*3600*1000)) : "";
      return { ...m, days_pending: days };
    }).sort((a,b)=> (b.days_pending||0) - (a.days_pending||0));
  }

  // Eksikleri Excel'e aktar
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

  // Barkod okunduğunda kısa "bip"
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

  // Arka kamerayı olabildiğince garantiye al
  async function getBackCameraConstraints(){
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === "videoinput");
      const rear = cams.find(c =>
        /back|rear|environment/i.test(c.label || "")
      ) || cams[cams.length - 1];
      if (rear?.deviceId) return { deviceId: { exact: rear.deviceId } };
    } catch {}
    return { facingMode: { exact: "environment" } };
  }

  // Kamera başlat
  async function startScan(){
    if(!clientReady){ alert("Tarayıcı hazır değil"); return; }
    if(typeof window === "undefined" || !window.Quagga){ alert("Tarama kütüphanesi yüklenmedi"); return; }
    if(scanning) return;

    setStatus("Kamera açılıyor...");
    const camConstraints = await getBackCameraConstraints();
    const targetEl = scannerRef.current; // Quagga hedefi DIV

    if(!targetEl){
      setStatus("Önizleme alanı bulunamadı");
      return;
    }

    window.Quagga.init({
      inputStream: {
        name: "Live",
        type: "LiveStream",
        target: targetEl,
        constraints: {
          ...camConstraints,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          aspectRatio: { ideal: 1.777 }
        }
      },
      locator: { patchSize:"medium", halfSample:true },
      numOfWorkers: (navigator.hardwareConcurrency || 4),
      decoder: { readers:["code_128_reader","code_39_reader","ean_reader","ean_8_reader","upc_reader","upc_e_reader"] },
      locate: true
    }, (err)=>{
      if(err){
        console.error(err);
        setStatus("Kamera hatası / izin verilmedi");
        return;
    }
      window.Quagga.start();
      setScanning(true);
      setStatus("Tarama açık");
    });

    window.Quagga.offDetected(); // önceki dinleyicileri temizle
    window.Quagga.onDetected(async res=>{
      const raw = res?.codeResult?.code || "";
      if(!raw) return;
      await onScan(raw);
      playBeep();
    });
  }

  // Kamera durdur
  function stopScan(){
    try { window.Quagga.stop(); } catch {}
    setScanning(false);
    setStatus("Durduruldu");
  }

  // Okunan barkodu received'e yaz
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
        <p style={{color:"#64748b"}}>Excel yükle → beklenenleri ekle. Telefonda kameradan okut → gelenler eklenir. Eksikleri indir.</p>
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
              <button onClick={stopScan} disabled={!scanning}>Durdur</button>
              <span>Son: <code>{lastCode}</code></span>
            </div>

            {/* ÖNİZLEME: Quagga video/canvas'ı bu DIV içine ekler */}
            <div
              ref={scannerRef}
              style={{
                width:"100%",
                height: 320,
                background:"#000",
                borderRadius:8,
                position:"relative",
                overflow:"hidden"
              }}
            />

            <div style={{marginTop:8}}>
              <input
                placeholder="Manuel barkod"
                onKeyDown={(e)=>{ if(e.key==='Enter'){ onScan(e.currentTarget.value); e.currentTarget.value=''; }}}
              />
              <button onClick={()=>{
                const el = document.querySelector("input[placeholder='Manuel barkod']");
                if(el && el.value){ onScan(el.value); el.value=''; }
              }}>Ekle</button>
            </div>
          </div>

          <div style={{border:"1px solid #e5e7eb", borderRadius:12, padding:12}}>
            <h3>📊 Durum</h3>
            <div>Beklenen: <b>{stats.expected}</b></div>
            <div>Gelen: <b style={{color:"#16a34a"}}>{stats.received}</b></div>
            <div>Eksik: <b style={{color:"#ef4444"}}>{stats.missing}</b></div>
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
  try{ return new Date(iso).toLocaleString(); } catch { return iso; }
}
