export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>Xmas Events — Server App</h1>
      <p>Se vedi questa pagina, il deploy su Vercel funziona.</p>
      <p><a href="/api/health">/api/health</a> — endpoint di test</p>
    </main>
  );
}
