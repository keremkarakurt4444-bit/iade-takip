# İade Takip (Next.js + Supabase)

## Ortam Değişkenleri (Vercel → Settings → Environment Variables)
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## Tablolar
- expected(barcode text PK, isim text, telefon text, added_at timestamptz default now())
- received(barcode text PK, received_at timestamptz default now())

## Geliştirme
```
npm install
npm run dev
```
