const GOOGLE_SITE_VERIFICATION_BODY =
  "google-site-verification: google1089c0cca1aa4f0a.html\n";

export function onRequestGet() {
  return new Response(GOOGLE_SITE_VERIFICATION_BODY, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
