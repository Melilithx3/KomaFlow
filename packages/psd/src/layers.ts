import type { ExportLayers } from '@komaflow/contract';

export type RasterLayerName = 'Notes' | 'Raw' | 'Clean';

export interface LayerPlan {
  name: RasterLayerName;
  hidden: boolean;
  /** 0..100 */
  opacity: number;
}

export interface AvailableFiles {
  raw: boolean;
  clean: boolean;
  notes: boolean;
}

/**
 * Which raster layers go into the PSD, top to bottom (docs/04-psd.md §2): Notes, Raw (hidden by
 * default), [group Text], Clean. The Text group is added by the generator between Raw and Clean.
 */
export function planLayers(
  layers: ExportLayers,
  files: AvailableFiles,
  settings: { raw_layer_visible: boolean; notes_opacity: number },
): LayerPlan[] {
  const plan: LayerPlan[] = [];
  if (layers.notes && files.notes) plan.push({ name: 'Notes', hidden: false, opacity: settings.notes_opacity });
  if (layers.raw && files.raw) plan.push({ name: 'Raw', hidden: !settings.raw_layer_visible, opacity: 100 });
  if (layers.clean && files.clean) plan.push({ name: 'Clean', hidden: false, opacity: 100 });
  return plan;
}

/** Validates the layer flags of an export request (docs/04-psd.md §2). Returns an error message or null. */
export function validateExportLayers(l: ExportLayers): string | null {
  if (!l.raw && !l.clean && !l.notes && !l.text) return 'at least one layer must be selected';
  return null;
}
