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

  // ========= EXCEL/CSV OKU — AŞIRI ESNEK =========
  async function handleExcel(fileList){
    if(!supabaseRef.current){ alert("Supabase ayarları eksik"); return; }
    if(!fileList || fileList.length===0){ alert("Dosya seçin"); return; }
    setStatus("Excel/CSV okunuyor...");

    let XLSX;
    try{
      XLSX = (await import("xlsx")).default;
    }catch(e){
      console.error(e);
      setStatus("Excel modülü yüklenemedi");
      return;
    }

    // Anahtarları normalize et: büyük/küçük, boşluk, Türkçe karakter fark etmez
    const normKey = (k)=> String(k||"")
      .normalize("NFKD")
      .replace(/\s+/g, "_")
      .replace(/[^\w]/g, "")
      .toUpperCase();

    // En yaygın başlık eşleştirmeleri
    const BARCODE_KEYS = new Set([
      "BARKOD","BARKOD_NO","BARKODNO","BARKODNUMARASI","BARCODE","MUSBARKODNO","MUSTERI_BARKOD","MUS_BARKOD_NO","KARGO_BARKOD","BARKODID"
    ]);
    const NAME_KEYS = new Set([
      "ALICI_ISIM","ALICIISIM","ISIM","MUSTERI_ADI","MUSTERIADI","ADSOYAD","AD_SOYAD","AD_SOYAD_","ALICI","MUSTERI_ISIM"
    ]);
    const PHONE_KEYS = new Set([
      "ALICI_TELEFON","ALICITELEFON","TELEFON","GSM","CEP","CEP_TELEFON","CEPTELEFON","TEL","MUSTERI_TEL","MUSTERITEL"
    ]);

    // Bir satır nesnesinden alan seçici
    const pick = (row, keySet)=>{
      for(const [k,v] of Object.entries(row)){
        if(keySet.has(k) && String(v).trim()!=="") return String(v).trim();
      }
      return "";
    };

    // Otomatik barkod tespit (başlık yoksa): sadece rakam, uzunluk >= 6-7
    const guessBarcodeFromRow = (row)=>{
      for(const v of Object.values(row)){
        const s = String(v||"").replace(/\D+/g,"");
        if(s && s.length>=6) return s;
      }
      return "";
    };

    let totalRead = 0, totalValid = 0;
    const upserts = [];

    for (const f of fileList){
      const buf = await f.arrayBuffer();
      const isCSV = /\.csv$/i.test(f.name||"");
      const wb = isCSV
        ? XLSX.read(new TextDecoder("utf-8").decode(buf), { type:"string" })
        : XLSX.read(buf, { type:"array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      // ham satırlar (ham başlıklarla)
      const rawRows = XLSX.utils.sheet_to_json(ws, { defval:"", raw:false });

      // Anahtarları normalize ederek yeni obje üret
      const rows = rawRows.map(obj=>{
        const n = {};
        for(const [k,v] of Object.entries(obj)) n[normKey(k)] = v;
        return n;
      });

      for (const r of rows){
        totalRead++;

        // 1) Önce bilinen başlıklardan barkod
        let barcodeRaw = pick(r, BARCODE_KEYS);
        // 2) Bulunamazsa otomatik tahmin
        if(!barcodeRaw) barcodeRaw = guessBarcodeFromRow(r);

        const barcode = normalize(barcodeRaw);
        if(!barcode) continue;

        const isim = pick(r, NAME_KEYS);
        const telefon = pick(r, PHONE_KEYS);

        upserts.push({ barcode, isim, telefon, added_at: new Date().toISOString() });
        totalValid++;
      }
    }

    if(totalValid===0){
      setStatus(`Dosya okundu ama uygun barkod bulunamadı (Toplam satır: ${totalRead}). Lütfen dosyadaki başlıkları bana yaz, listeye ekleyeyim.`);
      alert("Geçerli barkod bulunamadı. Dosya başlıklarını bana yazarsan hemen eklerim.");
      return;
    }

    setStatus(`Veritabanına yazılıyor... (${totalValid} satır)`);
    const { error } = await supabaseRef.current
      .from("expected")
      .upsert(upserts, { onConflict: "barcode" });
    if(error){
      console.error(error);
      alert("Hata: " + error.message);
      setStatus("Hata");
      return;
    }

    await refreshData();
    setStatus(`Hazır (Excel/CSV’den işlenen satır: ${totalValid}/${totalRead})`);
  }
  // ===============================================

  // Eksik listesi
  const missingList = useMemo(()=>{
    const recSet = new Set((received||[]).map(r=> normalize(r.barcode)));
    return (expected||[])
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

  // Excel dışa aktar (dinamik import)
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
    const rows = (received||[])
      .slice()
      .sort((a,b)=> new Date(b.added_at||0) - new Date(a.added_at||0))
      .map(r => ({ BARKOD_NO: r.barcode, OKUNDUGU_TARIH: humanDate(r.added_at) }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "GelenIadeler");
    XLSX.writeFile(wb, `Gelen_Iadeler_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  // Satır sil / Hepsini temizle
  async function deleteExpected(barcode){
    await supabaseRef.current.from("expected").delete().eq("barcode", barcode);
    await refreshData();
  }
  async function deleteReceived(barcode){
    await supabaseRef.current.from("received").delete().eq("barcode", barcode);
    await refreshData();
  }
  async function clearAll(){
    if(!confirm("Beklenen ve Gelen tablolardaki TÜM kayıtlar silinecek. Emin misin?")) return;
    await supabaseRef.current.from("expected").delete().neq("barcode", "");
    await supabaseRef.current.from("received").delete().neq("barcode", "");
    await refreshData();
  }

  // Kamera
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
      if(err){ console.error(err); setStatus("Kamera hatası / izin yok"); return; }
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
    const { error } = await supabaseRef.current
      .from("received")
      .upsert({ barcode: code, added_at: new Date().toISOString() }, { onConflict:"barcode" });
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
      {/* Quagga */}
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js" strategy="afterInteractive" />
      <div style={{padding:16,fontFamily:"system-ui",maxWidth:1100,margin:"0 auto"}}>
        <h1>İade Takip</h1>
        <p><b>Durum:</b> {status}</p>

        {/* Sayaçlar */}
        <div style={{display:"flex", gap:16, margin:"8px 0 16px 0", flexWrap:"wrap"}}>
          <div style={card}><b>Beklenen:</b> {stats.expected}</div>
          <div style={card}><b>Gelen:</b> {stats.received}</div>
          <div style={card}><b>Eksik:</b> {stats.missing}</div>
        </div>

        {/* Aksiyonlar */}
        <div style={{display:"flex", gap:8, flexWrap:"wrap", marginBottom:12}}>
          <input type="file" accept=".xls,.xlsx,.csv" onChange={e=>handleExcel(e.target.files)} />
          <button onClick={exportMissing}>Eksikleri Excel’e Aktar</button>
          <button onClick={exportReceived}>Gelenleri Excel’e Aktar</button>
          <button onClick={refreshData}>Yenile</button>
          <button onClick={clearAll}>Hepsini Temizle</button>
        </div>

        {/* Kamera */}
        <div style={panel}>
          <h3>Barkod Okut</h3>
          <div style={{display:"flex", gap:8, alignItems:"center", marginBottom:8}}>
            <button onClick={startScan}>Başlat</button>
            <button onClick={stopScan} disabled={!scanning}>Durdur</button>
            <span>Son: <code>{lastCode}</code></span>
          </div>
          <div ref={scannerRef} style={{width:"100%",height:320,background:"#000",borderRadius:8}} />
        </div>

        {/* Eksik İadeler */}
        <div style={panel}>
          <h3>Eksik İadeler</h3>
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
                      <td style={td}><code>{m.telefon}</code></td>
                      <td style={{...td, textAlign:"right"}}>{m.days_pending}</td>
                      <td style={{...td, textAlign:"right"}}>{humanDate(m.added_at)}</td>
                      <td style={{...td, textAlign:"right"}}>{humanDate(rec?.added_at)}</td>
                      <td style={td}><button onClick={()=>deleteExpected(m.barcode)}>Sil</button></td>
                    </tr>
                  );
                })}
                {missingList.length===0 && <tr><td colSpan={7} style={{padding:12, color:"#64748b"}}>Eksik iade yok</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* Gelen İadeler */}
        <div style={panel}>
          <h3>Gelen İadeler</h3>
          <div style={{overflow:"auto"}}>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead><tr><th style={th}>Barkod</th><th style={th}>Okunduğu Tarih</th><th style={th}>Sil</th></tr></thead>
              <tbody>
                {(received||[])
                  .slice()
                  .sort((a,b)=> new Date(b.added_at||0) - new Date(a.added_at||0))
                  .map(r=>(
                  <tr key={r.barcode}>
                    <td style={td}><code>{r.barcode}</code></td>
                    <td style={{...td, textAlign:"right"}}>{humanDate(r.added_at)}</td>
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

// Basit stiller
const panel = { border:"1px solid #e5e7eb", borderRadius:12, padding:12, marginTop:12 };
const th = { borderBottom:"1px solid #e5e7eb", textAlign:"left", padding:8 };
const td = { borderBottom:"1px solid #f1f5f9", padding:8 };
const card = { border:"1px solid #e5e7eb", borderRadius:8, padding:"6px 10px" };

// Normalize: sadece rakam + baştaki sıfırları at
function normalize(s){ return String(s||"").normalize("NFKC").replace(/\D+/g,"").replace(/^0+/,""); }
function humanDate(iso){ if(!iso) return ""; try{ return new Date(iso).toLocaleString(); }catch{ return iso; } }

// SSR kapalı
export default dynamic(() => Promise.resolve(PageInner), { ssr: false });
