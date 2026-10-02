"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" data-theme="dark">
      <body style={{ background: "#0c0d10", color: "#e9ebef", fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center", padding: 24 }}>
          <h1 style={{ fontSize: 18 }}>Forge hit an unexpected error.</h1>
          <p style={{ color: "#a2a8b3", fontSize: 13 }}>Your work is saved on the server. Reload to continue.</p>
          <button onClick={reset} style={{ marginTop: 12, background: "#7c6cf2", color: "#fff", border: 0, borderRadius: 6, padding: "8px 14px", cursor: "pointer" }}>
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
