import type { AdvisorRenderedRecipe } from './advisor-recipe-types';

export function magicLinkBrowserRecipe(): AdvisorRenderedRecipe {
  return {
    explanation: 'The emailed link lands on /auth/magic. redirect_uri is the post-verification destination, not the landing page. Serve the browser source below on /auth/magic; it redeems once, queues cookies and navigates. Request a fresh link after any failed attempt. For two-user proof use separate browser contexts. CLI token redemption is an alternative API test; it consumes the link and cannot precede browser verification of the same link. No token is exposed in the API response.',
    files: [{ path: 'api/auth/magic.ts', source: `export default async function (req, sw) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.token !== 'string' || !body.token) {
    return new Response('request a new sign-in link', { status: 400 });
  }
  try {
    const session = await sw.auth.verifyOtp({ token: body.token });
    sw.auth.setSessionCookies(session.token, session.refresh_token);
    const destination = new URL(session.redirect_uri ?? '/', req.url);
    // This example intentionally navigates only within the app.
    const redirect = destination.origin === new URL(req.url).origin &&
      destination.pathname !== '/auth/magic' ? destination.pathname + destination.search + destination.hash : '/';
    return Response.json({ redirect });
  } catch {
    return new Response('request a new sign-in link', { status: 400 });
  }
}
` }, { path: 'src/auth/magic.ts', source: `// Run once when the browser renders /auth/magic; do not call from a retried effect.
export async function completeMagicLink() {
  const token = new URLSearchParams(location.search).get('token');
  history.replaceState(null, '', '/auth/magic');
  if (!token) return 'Request a new sign-in link.';
  try {
    const response = await fetch('/api/auth/magic', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    if (!response.ok) return 'Request a new sign-in link.';
    const { redirect } = await response.json();
    const destination = new URL(redirect, location.origin);
    location.assign(destination.origin === location.origin && destination.pathname !== '/auth/magic'
      ? destination.href : '/');
  } catch {
    return 'Request a new sign-in link.';
  }
}
` }],
  };
}
