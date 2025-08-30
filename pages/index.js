// ... üstteki importlar aynı (Head, Script, XLSX vs.)

export default function Home(){
  // ... state'ler aynı
  const [selectedExpected, setSelectedExpected] = useState(new Set());
  const [selectedReceived, setSelectedReceived] = useState(new Set());

  // ... supabaseRef, useEffect, refreshData, handleExcel aynı

  // Tek tek seçme toggle
  function toggleExpected(barcode){
    const copy = new Set(selectedExpected);
    if(copy.has(barcode)) copy.delete(barcode); else copy.add(barcode);
    setSelectedExpected(copy);
  }
  function toggleReceived(barcode){
    const copy = new Set(selectedReceived);
    if(copy.has(barcode)) copy.delete(barcode); else copy.add(barcode);
    setSelectedReceived(copy);
  }

  // Seçileni sil
  async function deleteSelectedExpected(){
    if(selectedExpected.size===0) return;
    if(!confirm(`${selectedExpected.size} beklenen silinecek, emin misin?`)) return;
    const { error } = await supabaseRef.current.from("expected").delete().in("barcode", Array.from(selectedExpected));
    if(error) alert(error.message);
    setSelectedExpected(new Set());
    await refreshData();
  }
  async function deleteSelectedReceived(){
    if(selectedReceived.size===0) return;
    if(!confirm(`${selectedReceived.size} gelen silinecek, emin misin?`)) return;
    const { error } = await supabaseRef.current.from("received").delete().in("barcode", Array.from(selectedReceived));
    if(error) alert(error.message);
    setSelectedReceived(new Set());
    await refreshData();
  }

  // ... computeMissing, exportMissing, exportReceived, clearExpected, clearReceived, clearAll, playBeep, kamera fonksiyonları aynı

  return (
    <>
      <Head><title>İade Takip</title></Head>
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js" strategy="afterInteractive" />
      <div style={{maxWidth:1100, margin:"0 auto", padding:16, fontFamily:"system-ui"}}>
        <h1>📦 İade Takip</h1>
        <p><b>Durum:</b> {status}</p>

        <div style={{display:"flex", gap:8, flexWrap:"wrap", marginBottom:12}}>
          <input type="file" accept=".xls,.xlsx" multiple onChange={(e)=>handleExcel(e.target.files)} />
          <button onClick={exportMissing}>❌ Eksikleri Excel&apos;e Aktar</button>
          <button onClick={exportReceived}>📥 Gelenleri Excel&apos;e Aktar</button>
          <button onClick={refreshData}>Yenile</button>
          <span style={{flexGrow:1}} />
          <button onClick={clearExpected}>Beklenen’i Temizle</button>
          <button onClick={clearReceived}>Gelen’i Temizle</button>
          <button onClick={clearAll}>🧹 Hepsini Temizle</button>
        </div>

        {/* Eksik İadeler */}
        <div style={{marginTop:12, border:"1px solid #e5e7eb", borderRadius:12, padding:12}}>
          <h3>❌ Eksik İadeler</h3>
          <button onClick={deleteSelectedExpected} disabled={selectedExpected.size===0}>
            Seçileni Sil ({selectedExpected.size})
          </button>
          <div style={{overflow:"auto", marginTop:8}}>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr>
                  <th></th>
                  <th>BARKOD_NO</th>
                  <th>ALICI_ISIM</th>
                  <th>ALICI_TELEFON</th>
                  <th>Kaç Gündür Gelmedi</th>
                  <th>İlk Yükleme</th>
                  <th>Okunduğu Tarih</th>
                </tr>
              </thead>
              <tbody>
                {computeMissing().map(m=>{
                  const rec = received.find(r => normalize(r.barcode) === normalize(m.barcode));
                  return (
                    <tr key={m.barcode}>
                      <td><input type="checkbox" checked={selectedExpected.has(m.barcode)} onChange={()=>toggleExpected(m.barcode)} /></td>
                      <td>{m.barcode}</td>
                      <td>{m.isim}</td>
                      <td>{m.telefon}</td>
                      <td>{m.days_pending}</td>
                      <td>{humanDate(m.added_at)}</td>
                      <td>{humanDate(rec?.added_at)}</td>
                    </tr>
                  );
                })}
                {computeMissing().length===0 && (
                  <tr><td colSpan={7}>Eksik iade yok 🎉</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Gelen İadeler */}
        <div style={{marginTop:12, border:"1px solid #e5e7eb", borderRadius:12, padding:12}}>
          <h3>📥 Gelen İadeler</h3>
          <button onClick={deleteSelectedReceived} disabled={selectedReceived.size===0}>
            Seçileni Sil ({selectedReceived.size})
          </button>
          <div style={{overflow:"auto", marginTop:8}}>
            <table style={{width:"100%", borderCollapse:"collapse"}}>
              <thead>
                <tr>
                  <th></th>
                  <th>BARKOD_NO</th>
                  <th>Okunduğu Tarih</th>
                </tr>
              </thead>
              <tbody>
                {received.map(r=>(
                  <tr key={r.barcode}>
                    <td><input type="checkbox" checked={selectedReceived.has(r.barcode)} onChange={()=>toggleReceived(r.barcode)} /></td>
                    <td>{r.barcode}</td>
                    <td>{humanDate(r.added_at)}</td>
                  </tr>
                ))}
                {received.length===0 && (
                  <tr><td colSpan={3}>Henüz gelen iade yok</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// normalize & humanDate aynı
