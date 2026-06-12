export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'access-control-allow-origin': '*',
      'content-type': 'application/json',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    };

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(JSON.stringify({
        name: 'image-mcp',
        version: '1.0.0',
        description: 'Generate images via gpt-image-2. Returns base64 PNG.',
        tools: [{
          name: 'generate_image',
          description: 'Generate an image from a text prompt. Returns base64 PNG. Keep prompts short and natural.',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Short natural language image description' },
              size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024'], default: '1024x1024' },
            },
            required: ['prompt'],
          },
        }],
      }), { headers: cors });
    }

    if (req.method === 'POST' && url.pathname === '/tools/generate_image') {
      try {
        const body = await req.json();
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return new Response(JSON.stringify({ error: 'missing prompt' }), { status: 400, headers: cors });
        const size = ['1024x1024', '1024x1536', '1536x1024'].includes(body.size) ? body.size : '1024x1024';

        const resp = await fetch('https://987xyz.com/v1/images/generations', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'pro/gpt-image-2', prompt, n: 1, size, response_format: 'b64_json' }),
        });

        const data = await resp.json();
        if (data.data?.[0]?.b64_json) {
          return new Response(JSON.stringify({ result: { b64_json: data.data[0].b64_json, size, revised_prompt: data.data[0].revised_prompt || null } }), { headers: cors });
        }
        return new Response(JSON.stringify({ error: 'generation_failed', detail: JSON.stringify(data).slice(0, 500) }), { status: 502, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: cors });
      }
    }

    if (url.pathname === '/health') return new Response('OK');
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: cors });
  },
};
