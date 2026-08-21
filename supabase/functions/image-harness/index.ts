// Verification harness for the image pipeline. NOT part of the pipeline, not
// called by any cron, and DELIBERATELY LEFT UNDEPLOYED — every 'generate' or
// 'endtoend' call spends real money (one Flux generation plus two Claude
// vision calls), so it is deployed by hand for a verification run and removed
// again straight after:
//
//   supabase functions deploy image-harness --project-ref <ref>
//   …run the checks…
//   supabase functions delete image-harness --project-ref <ref>
//
// It exists because prompt and concept changes cannot be verified by reading
// them — the 19/20 Aug 2026 CRHQ failures were invisible until real images
// came back. It calls the SAME exported functions generatePostImage does
// (buildImagePrompt, generateWithFlux, reviewGeneratedImage,
// checkStyleCompliance), so what gets tested is the shipped code path rather
// than a parallel copy of it, and it runs in the project's own environment so
// it uses the real REPLICATE_API_TOKEN and the real mkt_clients row.
//
// Modes: 'concept' and 'buildprompt' are text-only and cheap; 'endtoend' runs
// a real post body all the way through to both real checks; 'generate' takes a
// verbatim prompt, for A/B-ing a new prompt against an old one;
// 'flux_negative_probe' checks what the Replicate model accepts.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  buildImagePrompt,
  checkStyleCompliance,
  generateWithFlux,
  reviewGeneratedImage,
  summariseToVisualConcept,
} from '../_shared/image.ts'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

Deno.serve(async (req: Request) => {
  try {
    const b = await req.json()
    const mode = String(b.mode ?? 'generate')

    if (mode === 'concept') {
      const concept = await summariseToVisualConcept(
        String(b.postBody ?? ''),
        String(b.system ?? ''),
        b.sourceTitle ?? null,
        b.validate === true,
      )
      return json({ mode, label: b.label ?? null, concept })
    }

    if (mode === 'buildprompt') {
      const { data: client } = await admin.from('mkt_clients').select('*').eq('slug', 'crhq').single()
      const built = await buildImagePrompt(String(b.postBody ?? ''), client.visual_style, client, b.sourceTitle ?? null)
      return json({ mode, label: b.label ?? null, ...built })
    }

    // Full production path for CRHQ: build the real prompt from the real post
    // body + real source title, then generate and run both real checks.
    if (mode === 'endtoend') {
      const { data: client } = await admin.from('mkt_clients').select('*').eq('slug', 'crhq').single()
      const built = await buildImagePrompt(String(b.postBody ?? ''), client.visual_style, client, b.sourceTitle ?? null)
      b.prompt = built.prompt
      b.concept = built.concept
      b.styleCheck = true
    }

    if (mode === 'flux_negative_probe') {
      // Empirical check: does flux-1.1-pro on Replicate accept a negative
      // prompt at all? A 422 here settles the negative-prompt hypothesis.
      const res = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${Deno.env.get('REPLICATE_API_TOKEN')}`,
          'Content-Type': 'application/json',
          Prefer: 'wait=1',
        },
        body: JSON.stringify({
          input: {
            prompt: 'a plain grey concrete wall',
            negative_prompt: 'text, letters, signage',
            aspect_ratio: '1:1',
            output_format: 'png',
          },
        }),
      })
      return json({ mode, status: res.status, body: (await res.text()).slice(0, 900) })
    }

    // mode === 'generate': real Flux call + real text/face backstop + real
    // visual_style compliance check, on a prompt supplied verbatim.
    const label = String(b.label ?? 'unlabelled')
    const prompt = String(b.prompt ?? '')
    if (!prompt) return json({ error: 'no prompt' }, 400)

    const token = Deno.env.get('REPLICATE_API_TOKEN')!
    const bytes = await generateWithFlux(prompt, token)

    const review = await reviewGeneratedImage(bytes)

    let style: unknown = null
    if (b.styleCheck) {
      const { data: client } = await admin.from('mkt_clients').select('visual_style').eq('slug', 'crhq').single()
      try {
        style = await checkStyleCompliance(bytes, String(client?.visual_style ?? ''))
      } catch (e) {
        style = { error: String((e as Error)?.message ?? e) }
      }
    }

    const path = `_harness/${Date.now()}-${label.replace(/[^a-z0-9-]/gi, '_')}.png`
    await admin.storage.from('mkt-assets').upload(path, bytes, { contentType: 'image/png', upsert: true })
    const { data: pub } = admin.storage.from('mkt-assets').getPublicUrl(path)

    return json({
      mode,
      label,
      concept: b.concept ?? null,
      url: pub?.publicUrl ?? null,
      verdict: review.verdict,
      reasons: review.reasons,
      text_findings: review.measurement?.text_findings ?? [],
      faces: review.measurement?.faces ?? [],
      style,
    })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
