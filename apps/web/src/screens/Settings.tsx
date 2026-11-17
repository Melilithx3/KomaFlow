import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import type { ProjectDTO, SessionDTO } from '@komaflow/contract';
import { api, HttpError } from '../lib/api.js';
import { fmtDate, t } from '../strings.js';
import { useProjects } from './Projects.js';

export function SettingsScreen() {
  return (
    <div className="page-pad settings">
      <h1>{t.settings.title}</h1>
      <ProjectSettings />
      <Devices />
      <Password />
    </div>
  );
}

function Devices() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ sessions: SessionDTO[] }>('GET', '/me/sessions') });
  const revoke = async (id: string) => {
    await api('DELETE', `/me/sessions/${id}`);
    await qc.invalidateQueries({ queryKey: ['sessions'] });
  };
  return (
    <section className="card">
      <h2>{t.settings.devices}</h2>
      {q.isPending ? (
        <p className="muted">{t.loading}</p>
      ) : (
        <ul className="sessions">
          {q.data?.sessions.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{s.device_name}</strong> · {s.client === 'desktop' ? t.settings.desktop : t.settings.web}
                {s.current && <span className="badge info">{t.settings.current}</span>}
                <div className="muted">{t.settings.lastUsed(fmtDate(s.last_used_at))}</div>
              </div>
              {!s.current && <button onClick={() => void revoke(s.id)}>{t.settings.revoke}</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Password() {
  const [oldPw, setOld] = useState('');
  const [newPw, setNew] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', '/me/password', { old_password: oldPw, new_password: newPw });
      setMsg({ ok: true, text: t.settings.passwordChanged });
      setOld('');
      setNew('');
    } catch (x) {
      setMsg({ ok: false, text: x instanceof HttpError ? x.message : t.errorGeneric });
    }
  };
  return (
    <form className="card form-grid" onSubmit={(e) => void submit(e)}>
      <h2>{t.settings.password}</h2>
      <label>
        {t.settings.oldPassword}
        <input type="password" value={oldPw} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" required />
      </label>
      <label>
        {t.settings.newPassword}
        <input type="password" value={newPw} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" minLength={8} required />
      </label>
      {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      <button className="primary">{t.settings.changePassword}</button>
    </form>
  );
}

/** Project form: title, languages, direction and the two PSD settings used in MVP (docs/06-web.md §1.6). */
function ProjectSettings() {
  const [params] = useSearchParams();
  const projects = useProjects();
  const qc = useQueryClient();
  const list = projects.data?.projects ?? [];
  const [id, setId] = useState<string | null>(params.get('project'));
  const project = list.find((p) => p.id === id) ?? list[0];
  const [form, setForm] = useState<ProjectDTO | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => setForm(project ? structuredClone(project) : null), [project]);
  if (!project || !form) return null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('PATCH', `/projects/${project.id}`, {
        title: form.title,
        source_lang: form.source_lang,
        target_lang: form.target_lang,
        reading_direction: form.reading_direction,
        settings: form.settings,
      });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      setMsg(t.settings.saved);
    } catch (x) {
      setMsg(x instanceof Error ? x.message : t.errorGeneric);
    }
  };
  const psd = form.settings.psd;
  const setPsd = (patch: Partial<typeof psd>) => setForm({ ...form, settings: { psd: { ...psd, ...patch } } });
  return (
    <form className="card form-grid" onSubmit={(e) => void save(e)}>
      <h2>{t.settings.project}</h2>
      {list.length > 1 && (
        <select aria-label={t.projects.project} value={project.id} onChange={(e) => setId(e.target.value)}>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      )}
      <label>
        {t.projects.titleField}
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
      </label>
      <label>
        {t.projects.sourceLang}
        <input value={form.source_lang} onChange={(e) => setForm({ ...form, source_lang: e.target.value })} required />
      </label>
      <label>
        {t.projects.targetLang}
        <input value={form.target_lang} onChange={(e) => setForm({ ...form, target_lang: e.target.value })} required />
      </label>
      <label>
        {t.projects.direction}
        <select value={form.reading_direction} onChange={(e) => setForm({ ...form, reading_direction: e.target.value as 'rtl' | 'ltr' })}>
          <option value="rtl">{t.projects.rtl}</option>
          <option value="ltr">{t.projects.ltr}</option>
        </select>
      </label>
      <h3>{t.settings.psd}</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={psd.raw_layer_visible}
          onChange={(e) => setForm({ ...form, settings: { psd: { ...psd, raw_layer_visible: e.target.checked } } })}
        />{' '}
        {t.settings.rawVisible}
      </label>
      <label>
        {t.settings.notesOpacity}
        <input
          type="number"
          min={0}
          max={100}
          value={psd.notes_opacity}
          onChange={(e) => setForm({ ...form, settings: { psd: { ...psd, notes_opacity: Math.round(Number(e.target.value)) } } })}
        />
      </label>
      <h3>{t.settings.text}</h3>
      <label>
        {t.settings.font}
        <input value={psd.default_font} onChange={(e) => setPsd({ default_font: e.target.value.trim() })} required maxLength={200} spellCheck={false} />
      </label>
      <div className="form-row">
        <label>
          {t.settings.dpi}
          <input type="number" min={1} max={2400} value={psd.dpi} onChange={(e) => setPsd({ dpi: Math.max(1, Math.round(Number(e.target.value))) })} />
        </label>
        <label>
          {t.settings.color}
          <input type="color" value={psd.text_color} onChange={(e) => setPsd({ text_color: e.target.value })} />
        </label>
        <label>
          {t.settings.justification}
          <select value={psd.justification} onChange={(e) => setPsd({ justification: e.target.value as typeof psd.justification })}>
            {(['left', 'center', 'right'] as const).map((j) => (
              <option key={j} value={j}>
                {t.settings.justify[j]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          {t.settings.minSize}
          <input type="number" min={1} max={1000} value={psd.min_font_size} onChange={(e) => setPsd({ min_font_size: Math.max(1, Math.round(Number(e.target.value))) })} />
        </label>
        <label>
          {t.settings.lineHeight}
          <input type="number" min={0.5} max={5} step={0.05} value={psd.line_height} onChange={(e) => setPsd({ line_height: Number(e.target.value) })} />
        </label>
      </div>
      <table className="settings-table">
        <thead>
          <tr>
            <th />
            <th>{t.settings.baseSize}</th>
            <th>{t.settings.padding}</th>
          </tr>
        </thead>
        <tbody>
          {(['bubble', 'sfx', 'onomatopoeia', 'text'] as const).map((k) => (
            <tr key={k}>
              <td>{t.settings.typeNames[k]}</td>
              <td>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={psd.base_font_size[k]}
                  onChange={(e) => setPsd({ base_font_size: { ...psd.base_font_size, [k]: Math.max(1, Math.round(Number(e.target.value))) } })}
                  aria-label={`${t.settings.baseSize}: ${t.settings.typeNames[k]}`}
                />
              </td>
              <td>
                <input
                  type="number"
                  min={0}
                  max={0.45}
                  step={0.01}
                  value={psd.text_padding[k]}
                  onChange={(e) => setPsd({ text_padding: { ...psd.text_padding, [k]: Math.min(0.45, Math.max(0, Number(e.target.value))) } })}
                  aria-label={`${t.settings.padding}: ${t.settings.typeNames[k]}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {msg && <p className="ok">{msg}</p>}
      <button className="primary">{t.save}</button>
    </form>
  );
}
