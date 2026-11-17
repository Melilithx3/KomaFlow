import { z } from 'zod';

const PerType = <T extends z.ZodType>(t: T) =>
  z.strictObject({ bubble: t, sfx: t, onomatopoeia: t, text: t });

/** PSD generation settings (docs/04-psd.md §3.1). */
export const PsdSettings = z.strictObject({
  default_font: z.string().min(1).max(200),
  dpi: z.number().int().min(1).max(2400),
  text_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  justification: z.enum(['left', 'center', 'right']),
  base_font_size: PerType(z.number().int().min(1).max(1000)),
  min_font_size: z.number().int().min(1).max(1000),
  line_height: z.number().min(0.5).max(5),
  text_padding: PerType(z.number().min(0).max(0.45)),
  raw_layer_visible: z.boolean(),
  notes_opacity: z.number().int().min(0).max(100),
});
export type PsdSettings = z.infer<typeof PsdSettings>;

export const DEFAULT_PSD_SETTINGS: PsdSettings = {
  default_font: 'ArialMT',
  dpi: 72,
  text_color: '#000000',
  justification: 'center',
  base_font_size: { bubble: 28, sfx: 40, onomatopoeia: 36, text: 24 },
  min_font_size: 10,
  line_height: 1.15,
  text_padding: { bubble: 0.1, sfx: 0, onomatopoeia: 0, text: 0 },
  raw_layer_visible: false,
  notes_opacity: 100,
};

/** Content of `projects.settings_json`. */
export const ProjectSettings = z.strictObject({ psd: PsdSettings });
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export function defaultProjectSettings(): ProjectSettings {
  return structuredClone({ psd: DEFAULT_PSD_SETTINGS });
}

export const ExportLayers = z.strictObject({
  raw: z.boolean(),
  clean: z.boolean(),
  notes: z.boolean(),
  text: z.boolean(),
});
export type ExportLayers = z.infer<typeof ExportLayers>;

/** MVP: text layers are not supported (docs/04-psd.md), `text` is always false. */
export const DEFAULT_EXPORT_LAYERS: ExportLayers = { raw: true, clean: true, notes: true, text: false };
