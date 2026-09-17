export const GET = () => new Response(JSON.stringify({ ok: true, service: 'marketplace-control' }), { headers: { 'content-type': 'application/json' } });
