# İade Takip (Vercel Upload Sürümü)

Bu sürüm, Supabase istemcisini yalnızca TARAYICI tarafında başlatır.
Vercel'de build sırasında env değişkenleri eksik olsa bile build kırılmaz.

## Gerekli Env
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_ANON_KEY

Vercel → Proje → Ayarlar → Çevre Değişkenleri bölümünden ekleyin.
