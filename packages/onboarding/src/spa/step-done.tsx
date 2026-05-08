export function StepDone() {
  return (
    <main style={{ maxWidth: 480, margin: '4rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>You're all set.</h1>
      <p>Setup complete — you can start chatting now.</p>
      <a href="/" style={{ display: 'inline-block', marginTop: '1rem', padding: '0.5rem 1rem', background: '#000', color: '#fff', textDecoration: 'none', borderRadius: 4 }}>
        Open chat →
      </a>
    </main>
  );
}
