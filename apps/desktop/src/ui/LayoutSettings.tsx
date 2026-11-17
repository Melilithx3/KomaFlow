import { OBJECT_TYPES, type ObjectType } from '@komaflow/contract';
import { TYPE_STYLE } from '@komaflow/page-view';
import { DEFAULT_LAYOUT_CLASSES, LAYOUT_CLASSES, type LayoutClass, type Settings } from './session.js';

const CLASS_RU: Record<LayoutClass, string> = { bubble: 'bubble (пузыри)', text: 'text (текст вне пузырей)', onomatopoeia: 'onomatopoeia (звуки)', panel: 'panel (панели)' };

/** Per-class layout parameters: on/off, our object type, score threshold (empty = model default). */
export function LayoutSettings({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const set = (c: LayoutClass, patch: Partial<Settings['layoutClasses'][LayoutClass]>) =>
    onChange({ ...settings, layoutClasses: { ...settings.layoutClasses, [c]: { ...settings.layoutClasses[c], ...patch } } });
  return (
    <div className="layout-settings">
      <table className="table">
        <thead>
          <tr>
            <th>Класс модели</th>
            <th>Искать</th>
            <th>Тип объекта</th>
            <th title="0–1; пусто — рекомендованный моделью">Порог уверенности</th>
          </tr>
        </thead>
        <tbody>
          {LAYOUT_CLASSES.map((c) => {
            const cs = settings.layoutClasses[c];
            return (
              <tr key={c} className={cs.enabled ? '' : 'off'}>
                <td>{CLASS_RU[c]}</td>
                <td>
                  <input type="checkbox" checked={cs.enabled} onChange={(e) => set(c, { enabled: e.target.checked })} aria-label={`Искать ${c}`} />
                </td>
                <td>
                  <select value={cs.type} disabled={!cs.enabled} onChange={(e) => set(c, { type: e.target.value as ObjectType })} aria-label={`Тип для ${c}`}>
                    {OBJECT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_STYLE[t].label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min={0.05}
                    max={0.99}
                    step={0.05}
                    placeholder="по модели"
                    disabled={!cs.enabled}
                    value={cs.threshold ?? ''}
                    onChange={(e) => set(c, { threshold: e.target.value === '' ? null : Math.min(0.99, Math.max(0.01, Number(e.target.value))) })}
                    aria-label={`Порог для ${c}`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row">
        <label className="check">
          Отступ кропа для OCR, px{' '}
          <input type="number" min={0} max={64} value={settings.ocrPaddingPx} onChange={(e) => onChange({ ...settings, ocrPaddingPx: Number(e.target.value) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.ocrOnlyEmpty} onChange={(e) => onChange({ ...settings, ocrOnlyEmpty: e.target.checked })} /> OCR только для пустых оригиналов
        </label>
        <span className="spacer" />
        <button onClick={() => onChange({ ...settings, layoutClasses: DEFAULT_LAYOUT_CLASSES })}>Сбросить</button>
      </div>
      <p className="muted small">Ниже порог — больше находок (и мусора), выше — только уверенные. Изменения применяются к следующему запуску разметки.</p>
    </div>
  );
}
