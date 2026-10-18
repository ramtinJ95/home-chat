import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ImageContent, MutableModels } from '@earendil-works/pi-ai';
import { Type, type Static } from 'typebox';
import { IMAGE_DIRECTORY, allowedImagePath } from '../../policy.ts';
import { codexPost } from '../codex.ts';

// Codex image generation and editing, as @howaboua/pi-codex-imagegen did it from the Pi CLI: the same schema, request
// and file names (IMAGE_FILE; src/server.ts collectGenerated picks the files up when the turn ends).
export const description = 'Generate/edit images; omit selectors to generate';

export const parameters = Type.Object({
  prompt: Type.String({description: 'Include target aspect ratio and quality'}),
  transparent_background: Type.Optional(Type.Boolean({description: 'True for transparency or cutouts; for edits preserve existing transparency unless asked to change it'})),
  referenced_image_paths: Type.Optional(Type.Union([Type.Array(Type.String(), {description: 'Local edit targets', maxItems: 5}), Type.Null()])),
  num_last_images_to_include: Type.Optional(Type.Union([Type.Integer({description: 'Smallest recent edit count', minimum: 1, maximum: 5}), Type.Null()])),
}, {additionalProperties: false});

// `recent(n)`: the conversation's newest n images, oldest first, or fewer when it has fewer.
export async function imagegen(models: MutableModels, cwd: string, turnId: string, args: Static<typeof parameters>,
  recent: (count: number) => Promise<ImageContent[]>, signal?: AbortSignal) {
  const paths = args.referenced_image_paths ?? [];
  const count = args.num_last_images_to_include ?? 0;
  if (paths.length && count) throw new Error('provide only one of referenced_image_paths or num_last_images_to_include');
  let sources: ImageContent[] = [];
  if (paths.length) {
    sources = await Promise.all(paths.map(async path =>
      ({type: 'image' as const, mimeType: 'image/png', data: (await readFile(await allowedImagePath(path, cwd))).toString('base64')})));
  } else if (count) {
    sources = await recent(count);
    if (sources.length !== count) throw new Error(`requested the last ${count} conversation images, but only ${sources.length} were available`);
  }
  const body = {
    prompt: args.prompt, model: 'gpt-image-2.5', background: args.transparent_background ? 'transparent' : 'opaque', quality: 'auto', size: 'auto',
    ...(sources.length && {images: sources.map(image => ({image_url: `data:${image.mimeType};base64,${image.data}`}))}),
  };
  const result = await codexPost(models, sources.length ? '/images/edits' : '/images/generations', body, signal,
    {'x-codex-image-turn-id': turnId}) as {data?: {b64_json?: unknown}[]};
  const images = (result.data ?? []).map(item => item.b64_json).filter(data => typeof data === 'string');
  if (!images.length) throw new Error('Image generation returned no image');
  const directory = join(cwd, IMAGE_DIRECTORY);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const saved: string[] = [];
  const name = 'ig_' + randomUUID().replaceAll('-', '');
  for (const [index, data] of images.entries()) {
    const path = join(directory, `${name}${index ? '_' + (index + 1) : ''}.png`);
    await writeFile(path, Buffer.from(data, 'base64'), {mode: 0o600});
    saved.push(relative(cwd, path));
  }
  return {
    output: [{type: 'text' as const, text: `Generated image: ${saved.join(', ')}`},
      ...images.map(data => ({type: 'image' as const, mimeType: 'image/png', data}))],
    details: {paths: saved},
  };
}
