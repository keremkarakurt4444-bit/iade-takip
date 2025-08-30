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
        const barcode = normalize(raw["BARKOD_NO"] || raw["BARKOD"] || raw["BARCODE"] || "");
        if(!barcode) continue;
        upserts.push({
          barcode,
          isim: (raw["ALICI_ISIM"] || raw["ISIM"] || "").toString().trim(),
          telefon: (raw["ALICI_TELEFON"] || raw["TELEFON"] || "").toString().trim(),
          added_at: new Date().toISOString()
        });
      }
    }
    const { error } = await supabaseRef.current.from("expected").upsert(upserts, { onConflict: "barcode" });
    if(error){ alert("Hata: " + error.message); setStatus("Hata"); return; }
    await refreshData();
  }

  // Eksikleri hesapla (normalize'lı karşılaştırma)
  const missingList = useMemo(()=>{
    const recSet = new Set(received.map(r=> normalize(r.barcode)));
    return (expected || [])
      .filter(e => !recSet.has(normalize(e.barcode)))
      .map(m=>{
        const days = m.added_at ? Math.floor((Date.now() - new Date(m.added_at).getTime()) / (24*3600*1000)) : "";
        return { ...m, days_pending: days };
      })
      .sort((a,b)=> (b.days_pending||0) - (a.days_pending||0));
  }, [expected, received]);

  // Sayaçlar
  const stats = useMemo(()=>({
    expected: expected.length,
    received: received.length,
    missing: missingList.length
  }), [expected, received, missingList]);

  // Excel dışa aktar
  function exportMissing(){
    const rows = missingList.map(m => {
      const rec = received.find(r => normalize(r.barcode) === normalize(m.barcode));
      return {
        BARKOD_NO: m.barcode,
        ALICI_ISIM: m.isim || "",
        ALICI_TELEFON: m.telefon || "",
        KAC_GUNDUR_GELMEDI: m.days_pending,
        ILK_YUKLEME_TARIHI: humanDate(m.added_at),
        OKUNDUGU_TARIH: humanDate(rec?.added_at)
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "EksikIadeler");
    XLSX.writeFile(wb, `Eksik_Iadeler_${new Date().toISOString().slice(0,10)}.xlsx`);
  }
  function exportReceived(){
    const rows = (received || [])
      .slice()
      .sort((a,b)=> new Date(b.added_at||0) - new Date(a.added_at||0))
      .map(r => ({
        BARKOD_NO: r.barcode,
        OKUNDUGU_TARIH: humanDate(r.added_at)
      }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "GelenIadeler");
    XLSX.writeFile(wb, `Gelen_Iadeler_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  // Satır sil
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
    if(!confirm("Beklenen ve Gelen tablolardaki TÜM kayıtlar silinecek. Emin misin?")) return;
    await supabaseRef.current.from("expected").delete().neq("barcode", "");
    await supabaseRef.current.from("received").delete().neq("barcode", "");
    await refreshData();
  }

  // Kamera
  async function startScan(){
    if(!clientReady) return;
    if(typeof window === "undefined" || !window.Quagga) return;
    if(scanning) return;
    window.Quagga.init({
      inputStream: { type:"LiveStream", target: scannerRef.current, constraints:{ facingMode:"environment" } },
      decoder: { readers:["code_128_reader","ean_reader","ean_8_reader","upc_reader","upc_e_reader"] },
      locate: true
    }, (err)=>{
      if(err){ setStatus("Kamera hatası"); return; }
      window.Quagga.start(); setScanning(true); setStatus("Tarama açık");
    });
    window.Quagga.offDetected();
    window.Quagga.onDetected(async res=>{
      const raw = res?.codeResult?.code || "";
      if(!raw) return;
      await onScan(raw);
      playBeep();
    });
  }
  function stopScan(){ try { window.Quagga.stop(); } catch{}; setScanning(false); setStatus("Durduruldu"); }
  async function onScan(raw){
    const code = normalize(raw); if(!code) return;
    setLastCode(code);
    const { error } = await supabaseRef.current
      .from("received")
      .upsert({ barcode: code, added_at:new Date().toISOString() }, { onConflict:"barcode" });
    if(error){ setStatus("Hata: " + error.message); return; }
    await refreshData();
    if(navigator.vibrate) navigator.vibrate(30);
  }
  function playBeep(){
    try{
      const ctx = new (window.AudioContext||window.webkitAudioContext)();
      const osc = ctx.createOscillator(); osc.type="sine"; osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime+0.12);
    }catch{}
  }

  return (
    <>
      <Head><title>İade Takip</title></Head>
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js" strategy="afterInteractive" />
      <div style={{padding:16,fontFamily:"system-ui",maxWidth:1100,margin:"0 auto"}}>
        <h1>📦 İade Takip</h1>
        <p><b>Durum:</b> {status}</p>

        {/* Sayaçlar */}
        <div style={{display:"flex", gap:16, margin:"8px 0 16px 0", flexWrap:"wrap"}}>
          <div style={card}><b>Beklenen:</b> {stats.expected}</div>
          <div style={card}><b>Gelen:</b> {stats.received}</div>
          <div style={card}><b>Eksik:</b> {stats.missing}</div>
        </div>

        {/* Aksiyonlar */}
        <div style={{display:"flex", gap:8, flexWrap:"wrap", marginBottom:12}}>
          <input type="file" accept=".xls,.xlsx" onChange={e=>handleExcel(e.target.files)} />
          <button onClick={exportMissing}>❌ Eksikleri Excel</button>
          <button onClick={exportReceived}>📥 Gelenleri Excel</button>
          <button onClick={refreshData}>Yenile</button>
          <button onClick={clearAll}>🧹 Hepsini Temizle</button>
        </div>

        {/* Kamera */}
        <div style={panel}>
          <h3>📷 Barkod Okut</h3>
          <div style={{display:"flex", gap:8, alignItems:"center", marginBottom:8}}>
            <button onClick={startScan}>Başlat</button>
            <button onClick={stopScan} disabled={!scanning}>Durdur</button>
            <span>Son: <code>{lastCode}</code></span>
          </div>
          <div ref={scannerRef} style={{width:"100%",height:320,background:"#000",borderRadius:8}} />
        </div>

        {/* Eksik İadeler */}
        <div style={panel}>
          <h3>❌ Eksik İadeler</h3>
          <div style={{overflow:"auto"}}>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr>
                  <th style={th}>Barkod</th>
                  <th style={th}>İsim</th>
                  <th style={th}>Tel</th>
                  <th style={th}>Kaç Gün</th>
                  <th style={th}>İlk Yükleme</th>
                  <th style={th}>Okunduğu Tarih</th>
                  <th style={th}>Sil</th>
                </tr>
              </thead>
              <tbody>
                {missingList.map(m=>{
                  const rec = received.find(r => normalize(r.barcode) === normalize(m.barcode));
                  return (
                    <tr key={m.barcode}>
                      <td style={td}><code>{m.barcode}</code></td>
                      <td style={td}>{m.isim}</td>
                      <td style={td}><code>{m.telefon}</code></td>
                      <td style={{...td, textAlign:"right"}}>{m.days_pending}</td>
                      <td style={{...td, textAlign:"right"}}>{humanDate(m.added_at)}</td>
                      <td style={{...td, textAlign:"right"}}>{humanDate(rec?.added_at)}</td>
                      <td style={td}><button onClick={()=>deleteExpected(m.barcode)}>Sil</button></td>
                    </tr>
                  );
                })}
                {missingList.length===0 && (
                  <tr><td colSpan={7} style={{padding:12, color:"#64748b"}}>Eksik iade yok 🎉</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Gelen İadeler */}
        <div style={panel}>
          <h3>📥 Gelen İadeler</h3>
          <div style={{overflow:"auto"}}>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr>
                  <th style={th}>Barkod</th>
                  <th style={th}>Okunduğu Tarih</th>
                  <th style={th}>Sil</th>
                </tr>
              </thead>
              <tbody>
                {received
                  .slice()
                  .sort((a,b)=> new Date(b.added_at||0) - new Date(a.added_at||0))
                  .map(r=>(
                  <tr key={r.barcode}>
                    <td style={td}><code>{r.barcode}</code></td>
                    <td style={{...td, textAlign:"right"}}>{humanDate(r.added_at)}</td>
                    <td style={td}><button onClick={()=>deleteReceived(r.barcode)}>Sil</button></td>
                  </tr>
                ))}
                {received.length===0 && (
                  <tr><td colSpan={3} style={{padding:12, color:"#64748b"}}>Henüz gelen iade yok</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </>
  );
}

const panel = { border:"1px solid #e5e7eb", borderRadius:12, padding:12, marginTop:12 };
const th = { borderBottom:"1px solid #e5e7eb", textAlign:"left", padding:8 };
const td = { borderBottom:"1px solid #f1f5f9", padding:8 };

// rakam dışı temizle + baştaki sıfırları at
function normalize(s){ return String(s||"").normalize("NFKC").replace(/\D+/g,"").replace(/^0+/,""); }
function humanDate(iso){ if(!iso) return ""; try { return new Date(iso).toLocaleString(); } catch { return iso; } }
