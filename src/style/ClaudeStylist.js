/**
 * The style source that actually looks at your room.
 *
 * Instead of picking blindly from a list, this hands Claude a frame from the
 * camera and asks it to invent a world *for what it can actually see* — and,
 * crucially, to say what each recognised object becomes in it, so the TV and
 * the sofa get different answers rather than the same tint. The reply is the
 * same small bundle of numbers a built-in theme is, so nothing downstream
 * changes: `ThemeDirector` validates it with `makeTheme` and the shader
 * renders it identically. That symmetry is the point of the seam.
 *
 * ## Why this talks to a relay instead of to Anthropic directly
 *
 * An API key is a bearer credential. Anything shipped to the browser is
 * readable by anyone who opens the page — on static hosting like GitHub Pages
 * there is nowhere to put a secret, so a key embedded in the app is a key
 * given away, and the bill is yours. The relay (`tools/style-relay.js`) keeps
 * the key server-side and is the only supported way to share the link.
 *
 * `directKey` exists for one narrow case: your own phone, your own key, never
 * shared. It is stored only in that device's localStorage and sent straight to
 * Anthropic. Convenient for trying this out before standing up a server; not
 * something to hand to a friend.
 */

/** Grab the current video frame as a base64 JPEG, downscaled for the wire. */
export function captureFrameBase64(video, maxWidth = 512, quality = 0.8) {
  const vw = video?.videoWidth || 0;
  const vh = video?.videoHeight || 0;
  if (!vw || !vh) return null;

  const scale = Math.min(1, maxWidth / vw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vw * scale));
  canvas.height = Math.max(1, Math.round(vh * scale));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

  // Strip the `data:image/jpeg;base64,` prefix — the API wants raw base64.
  return canvas.toDataURL('image/jpeg', quality).split(',')[1] || null;
}

/**
 * Exported so the relay uses this exact text too — the prompt is the part
 * most likely to need tuning after seeing real output, and having two copies
 * drift apart would mean the two paths quietly produce different styles.
 */
export const SYSTEM_PROMPT = `You dress real rooms for an augmented-reality app.

The user is looking at a real room through their phone. You will be shown a photo of it. The app can recognise individual objects in view — chair, sofa, tv, dining table, potted plant, bottle, person — and paint each one as a different material. Your job is to invent one coherent world and say what each thing becomes in it.

The renderer keeps every object's real shading and position and only replaces its appearance, so the room stays reachable — a chair repainted as iron is still exactly where the chair is, and still sittable.

Reply with a JSON object:
{
  "id": short-slug,
  "name": 2-4 words,
  "blurb": one short evocative sentence, second person,
  "base": <material>,          // walls, floor, everything unrecognised
  "objects": {                 // optional; omit any you have nothing to say about
    "tv": <material>, "sofa": <material>, "chair": <material>,
    "dining table": <material>, "potted plant": <material>, "person": <material>
  }
}

A <material> is:
- ramp: 4 hex colours, darkest to brightest. This IS the material. It must keep a wide spread from dark to light — the ramp carries the real shading, and a flat ramp makes things look painted-on and unreachable. Never make all four similar.
- chroma (0-1): how much of the object's real colour survives. Keep LOW (0.03-0.15). High values look like a filter over a sofa instead of a sofa made of something else. The exception is a screen or a light source, where 0.4+ keeps it looking lit.
- contrast (0.2-3): steepens shading. ~1.1-1.4 usually; below 1 flattens.
- texture: none | grain | veins | brushed | hammered | weave
- textureScale (1-400): higher is finer. grain ~150, veins ~30, brushed ~120, hammered ~90, weave ~220.
- textureStrength (0-1): 0.1-0.3 convinces; above 0.4 buries the shape.
- edgeStrength (0-1) + edgeColor: outlines, drawn from the object's own detail. High + dark reads as ink or as a drawn line; high + bright reads as glowing or lit from within.
- sheen (0-1.5) + sheenColor: makes bright areas bloom. High for metal, ice, glaze, screens; near zero for stone, cloth, moss.

Make the objects genuinely different from the base and from each other — that contrast is the entire effect, and it has to live in the RAMP. Outlines are drawn from detail in the photo, so they appear at a silhouette and at creases and nowhere else; across the broad flat middle of a sofa there is no detail and all that shows is the ramp. Two objects that share a ramp and differ only in edgeColor read as one tinted room, which is the failure mode to avoid. Give every object a ramp clearly apart from the base's — different hue, or clearly lighter or darker — and use edges and sheen on top of that, never instead of it.

Two worked ideas:
- A TV becomes a whiteboard with a near-white ramp, contrast ~0.7 and edgeStrength 1.0 in dark ink: the screen's own picture is redrawn as marker strokes.
- In a dark room, a sofa becomes a gaming couch lit magenta from beneath — a ramp running deep plum to hot pink, well above the walls in brightness, with edgeStrength ~1.0 in hot magenta on top. The lit furniture is what you see; the room recedes.

Choose something suited to what you actually see, and vary your choices — do not default to the same world every time.`;

export class ClaudeStylist {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video Frame source.
   * @param {string} [opts.endpoint] Relay URL. Preferred.
   * @param {string} [opts.directKey] Personal-device fallback; see the note above.
   * @param {number} [opts.maxWidth] Longest edge sent, in pixels.
   */
  constructor({ video, endpoint = '', directKey = '', maxWidth = 512 } = {}) {
    this.name = 'Claude';
    this.video = video;
    this.endpoint = endpoint;
    this.directKey = directKey;
    this.maxWidth = maxWidth;
  }

  get configured() {
    return Boolean(this.endpoint || this.directKey);
  }

  async pick({ exclude } = {}) {
    if (!this.configured) {
      throw new Error('No Claude endpoint or key configured.');
    }
    const image = captureFrameBase64(this.video, this.maxWidth);
    if (!image) throw new Error('The camera has not produced a frame yet.');

    return this.endpoint
      ? this._viaRelay(image, exclude)
      : this._direct(image, exclude);
  }

  async _viaRelay(image, exclude) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image, exclude }),
    });
    if (!res.ok) {
      throw new Error(`Style service returned ${res.status}. ${await res.text().catch(() => '')}`.trim());
    }
    const body = await res.json();
    if (!body || typeof body !== 'object') throw new Error('Style service sent an unreadable reply.');
    return body.theme || body.style || body;
  }

  async _direct(image, exclude) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.directKey,
        'anthropic-version': '2023-06-01',
        // Without this the API refuses browser origins outright — it is a
        // deliberate guard against exactly the key-exposure risk above.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(buildRequest(image, exclude)),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Claude returned ${res.status}. ${detail}`.trim());
    }
    const body = await res.json();
    return extractStyle(body);
  }
}

/**
 * The Messages request, shared by the browser-direct path and the relay.
 *
 * `effort: low` is a UX decision, not a cost one: someone is standing in a
 * headset waiting for the room to change, and choosing a palette from a photo
 * is well within what Opus 5 does easily at low effort. Raise it if the picks
 * ever feel careless.
 */
export function buildRequest(imageBase64, exclude) {
  const avoid = exclude ? `\n\nThe room is currently "${exclude}". Choose something clearly different.` : '';
  return {
    model: 'claude-opus-5',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        {
          type: 'text',
          text: `Dress this room.${avoid}\n\nReply with only the JSON object. No prose, no code fence.`,
        },
      ],
    }],
  };
}

/**
 * Pull the style object out of a raw Messages response.
 *
 * Tolerates a code fence or a stray sentence around the JSON. The browser-
 * direct path has no schema enforcement (that needs the SDK, which needs a
 * build step this app deliberately does not have), so it has to cope with
 * ordinary model output; the relay uses structured outputs and does not.
 */
export function extractStyle(responseBody) {
  const text = (responseBody?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (!text) throw new Error('Claude replied without any text.');

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Claude did not reply with a style.');

  return JSON.parse(candidate.slice(start, end + 1));
}

export default ClaudeStylist;
