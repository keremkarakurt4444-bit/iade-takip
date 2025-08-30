import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import Script from "next/script";

function PageInner(){
  const [status, setStatus] = useState("Hazır");
  const [expected, setExpected] = useState([]);
  const [received, setReceived] = useState([]);
  const [lastCode, setLastCode] = useState("");
  const [scanning, setScanning] = useState(false);

  const supabaseRef = useRef(null);
  const scannerRef = useRef(null);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  useEffect(()=>{
    (async ()=>{
      if(!url || !key){
        setStatus("Supabase ayarları eksik: Vercel → Environment Variables");
        return;
      }
      try{
        const { createClient } = await import("@supabase/supabase-js");
        supabaseRef.current = createClient(url, key);
        await refreshData();
      }catch(e){
        console.error(e);
        setStatus("Supabase başlatılamadı");
      }
    })();
    return ()=>{ try{ window?.Quagga?.stop(); }catch{} };
  }, []);

  async function refreshData(){
    if(!supabaseRef.current) return;
    setStatus("Veriler çekiliyor...");
    const { data: exp } = await supabaseRef.current.from("expected").select("*");
    const { data: rec } = await supabaseRef.current.from("received").select("*");
    setExpected(exp || []);
    setReceived(rec || []);
    setStatus("Hazır");
  }

  // Excel/CSV içe aktar
  async function handleExcel(fileList){
    if(!supabaseRef.current){ alert("Supabase ayarları eksik"); return; }
    if(!fileList || fileList.length===0){ alert("Excel seçin"); return; }
    setStatus("Excel okunuyor...");

    let XLSX;
    try{
      XLSX = (await import("xlsx")).default;
    }catch(e){
      console.error(e);
      setStatus("Excel modülü yüklenemedi");
      return;
    }

    const normKey = (k)=> String(k||"")
      .normalize("NFKD")
      .replace(/\s+/g, "_")
      .replace(/[^\w]/g, "")
      .toUpperCase();

    const pickField = (row, names)=>{
      for(const n of names){
        if(row[n] !== undefined && String(row[n]).trim() !== "") return String(row[n]).trim();
      }
      return "";
    };

    const upserts = [];
    for(const f of fileList){
      const buf = await f.arrayBuffer();
      const wb = /\.csv$/i.test(f.name||"")
        ? XLSX.read(new TextDecoder("utf-8").decode(buf), { type:"string" })
        : XLSX.read(buf, { type:"array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(ws, { defval:"", raw: false });

      const rows = rawRows.map(obj=>{
        const n = {};
        for(const [k,v] of Object.entries(obj)) n[normKey(k)] = v;
        return n;
      });

      for (const r of rows){
        const barcodeRaw = r["BARKOD"] || r["BARKODNO"] || r["MUSBARKODNO"] || r["BARCODE"] || r["MUSTERI_BARKOD"] || "";
        const barcode = normalize(barcodeRaw);
        if(!barcode) continue;

        const isim = pickField(r, ["ALICIISIM","ISIM","MUSTERIADI","ADSOYAD"]);
        const telefon = pickField(r, ["ALICITELEFON","TELEFON","GSM","CEP"]);

        upserts.push({ barcode, isim, telefon, added_at: new Date().toISOString() });
      }
    }

    if(upserts.length===0){
      setStatus("Excel okundu ama uygun satır bulunamadı");
      return;
    }

    const { error } = await supabaseRef.current.from("expected").upsert(upserts, { onConflict: "barcode" });
    if(error){ alert("Hata: " + error.message); setStatus("Hata"); return; }

    await refreshData();
    setStatus(`Hazır (Excel’den ${upserts.length} satır işlendi)`);
  }

  const missingList = useMemo(()=>{
    const recSet = new Set((received||[]).map(r=> normalize(r.barcode)));
    return (expected||[])
      .filter(e => !recSet.has(normalize(e.barcode)))
      .map(m=>{
        const days = m.added_at ? Math.floor((Date.now() - new Date(m.added_at).getTime()) / (24*3600*1000)) : "";
        return { ...m, days_pending: days };
      });
  }, [expected, received]);

  const stats = useMemo(()=>({
    expected: expected.length,
    received: received.length,
    missing: missingList.length
  }), [expected, received, missingList]);

  async function exportMissing(){
    const XLSX = (await import("xlsx")).default;
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
  async function exportReceived(){
    const XLSX = (await import("xlsx")).default;
    const rows = (received||[]).map(r => ({ BARKOD_NO: r.barcode, OKUNDUGU_TARIH: humanDate(r.added_at) }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "GelenIadeler");
    XLSX.writeFile(wb, `Gelen_Iadeler_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  async function deleteExpected(barcode){
    await supabaseRef.current.from("expected").delete().eq("barcode", barcode);
    await refreshData();
  }
  async function deleteReceived(barcode){
    await supabaseRef.current.from("received").delete().eq("barcode", barcode);
    await refreshData();
  }
  async function clearAll(){
    if(!confirm("Tüm kayıtlar silinecek. Emin misin?")) return;
    await supabaseRef.current.from("expected").delete().neq("barcode", "");
    await supabaseRef.current.from("received").delete().neq("barcode", "");
    await refreshData();
  }

  async function startScan(){
    setStatus("Kamera hazırlanıyor...");
    const Quagga = window?.Quagga;
    if(!Quagga){ setStatus("Tarama kütüphanesi yüklenmedi"); return; }
    if(scanning) return;

    Quagga.init({
      inputStream: { type:"LiveStream", target: scannerRef.current, constraints:{ facingMode:"environment" } },
      decoder: { readers:["code_128_reader","ean_reader","ean_8_reader","upc_reader","upc_e_reader"] },
      locate: true
    }, (err)=>{
      if(err){ console.error(err); setStatus("Kamera hatası"); return; }
      Quagga.start(); setScanning(true); setStatus("Tarama açık");
    });

    Quagga.offDetected();
    Quagga.onDetected(async res=>{
      const raw = res?.codeResult?.code || "";
      if(!raw) return;
      await onScan(raw);
      playBeep();
    });
  }
  function stopScan(){
    try{ window?.Quagga?.stop(); }catch{}
    setScanning(false);
    setStatus("Durduruldu");
  }
  async function onScan(raw){
    const code = normalize(raw); if(!code) return;
    setLastCode(code);
    await supabaseRef.current.from("received").upsert({ barcode: code, added_at: new Date().toISOString() }, { onConflict:"barcode" });
    await refreshData();
    if(navigator.vibrate) navigator.vibrate(30);
  }
  function playBeep(){
    try{
      const ctx = new (window.AudioContext||window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      osc.type="sine"; osc.frequency.setValueAtTime(880, ctx.currentTime);
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

        <div style={{display:"flex", gap:16, margin:"8px 0 16px 0", flexWrap:"wrap"}}>
          <div style={card}><b>Beklenen:</b> {stats.expected}</div>
          <div style={card}><b>Gelen:</b> {stats.received}</div>
          <div style={card}><b>Eksik:</b> {stats.missing}</div>
        </div>

        <div style={{display:"flex", gap:8, flexWrap:"wrap", marginBottom:12}}>
          <input type="file" accept=".xls,.xlsx,.csv" onChange={e=>handleExcel(e.target.files)} />
          <button onClick={exportMissing}>❌ Eksikleri Excel</button>
          <button onClick={exportReceived}>📥 Gelenleri Excel</button>
          <button onClick={refreshData}>Yenile</button>
          <button onClick={clearAll}>🧹 Hepsini Temizle</button>
        </div>

        <div style={panel}>
          <h3>📷 Barkod Okut</h3>
          <div style={{display:"flex", gap:8, alignItems:"center", marginBottom:8}}>
            <button onClick={startScan}>Başlat</button>
            <button onClick={stopScan} disabled={!scanning}>Durdur</button>
            <span>Son: <code>{lastCode}</code></span>
          </div>
          <div id="preview" ref={scannerRef} style={{width:"100%",height:320,background:"#000",borderRadius:8}} />
        </div>

        <div style={panel}>
          <h3>❌ Eksik İadeler</h3>
          <div style={{overflow:"auto"}}>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead><tr>
                <th style={th}>Barkod</th><th style={th}>İsim</th><th style={th}>Tel</th><th style={th}>Kaç Gün</th>
                <th style={th}>İlk Yükleme</th><th style={th}>Okunduğu Tarih</th><th style={th}>Sil</th>
              </tr></thead>
              <tbody>
                {missingList.map(m=>{
                  const rec = received.find(r => normalize(r.barcode) === normalize(m.barcode));
                  return (
                    <tr key={m.barcode}>
                      <td style={td}><code>{m.barcode}</code></td>
                      <td style={td}>{m.isim}</td>
                      <td style={td}>{m.telefon}</td>
                      <td style={td}>{m.days_pending}</td>
                      <td style={td}>{humanDate(m.added_at)}</td>
                      <td style={td}>{humanDate(rec?.added_at)}</td>
                      <td style={td}><button onClick={()=>deleteExpected(m.barcode)}>Sil</button></td>
                    </tr>
                  );
                })}
                {missingList.length===0 && <tr><td colSpan={7} style={{padding:12, color:"#64748b"}}>Eksik iade yok 🎉</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div style={panel}>
          <h3>📥 Gelen İadeler</h3>
          <div style={{overflow:"auto"}}>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead><tr><th style={th}>Barkod</th><th style={th}>Okunduğu Tarih</th><th style={th}>Sil</th></tr></thead>
              <tbody>
                {(received||[]).map(r=>(
                  <tr key={r.barcode}>
                    <td style={td}><code>{r.barcode}</code></td>
                    <td style={td}>{humanDate(r.added_at)}</td>
                    <td style={td}><button onClick={()=>deleteReceived(r.barcode)}>Sil</button></td>
                  </tr>
                ))}
                {(received||[]).length===0 && <tr><td colSpan={3} style={{padding:12, color:"#64748b"}}>Henüz gelen yok</td></tr>}
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
const card = { border:"1px solid #e5e7eb", borderRadius:8, padding:"6px 10px" };

function normalize(s){ return String(s||"").normalize("NFKC").replace(/\D+/g,"").replace(/^0+/,""); }
function humanDate(iso){ if(!iso) return ""; try{ return new Date(iso).toLocaleString(); }catch{ return iso; } }

export default dynamic(() => Promise.resolve(PageInner), { ssr: false });
