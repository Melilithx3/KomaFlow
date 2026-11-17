import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import type { ChapterListItem, ProjectDTO } from '@komaflow/contract';
import { api } from '../lib/api.js';
import { t } from '../strings.js';
import { ErrorBox } from '../App.js';

const LAST = 'komaflow:last-project';

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: ProjectDTO[] }>('GET', '/projects') });
}

function Progress({ label, n, total }: { label: string; n: number; total: number }) {
  return (
    <div className="progress">
      <span>
        {label} {n}/{total}
      </span>
      <meter min={0} max={Math.max(1, total)} value={n} aria-label={`${label} ${n} из ${total}`} />
    </div>
  );
}

export function ProjectsScreen() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const projects = useProjects();
  const [creating, setCreating] = useState(false);

  if (projects.isPending) return <p className="center muted">{t.loading}</p>;
  if (projects.error) return <ErrorBox error={projects.error} retry={() => void projects.refetch()} />;
  const list = projects.data.projects;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LAST);
  } catch {
    stored = null;
  }
  const current = list.find((p) => p.id === projectId) ?? list.find((p) => p.id === stored) ?? list[0];

  return (
    <div className="page-pad">
      <div className="row wrap">
        <h1>{t.projects.title}</h1>
        {list.length > 0 && (
          <select
            aria-label={t.projects.project}
            value={current?.id}
            onChange={(e) => {
              try {
                localStorage.setItem(LAST, e.target.value);
              } catch {
                // ignore
              }
              nav(`/projects/${e.target.value}`);
            }}
          >
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        )}
        {current && <Link to={`/settings?project=${current.id}`}>{t.projects.settings}</Link>}
        <span className="spacer" />
        <button onClick={() => setCreating((v) => !v)}>{t.projects.create}</button>
      </div>
      {creating && <CreateProject onDone={(id) => (setCreating(false), nav(`/projects/${id}`))} />}
      {list.length === 0 ? <p className="muted">{t.projects.empty}</p> : current && <Chapters project={current} />}
    </div>
  );
}

function Chapters({ project }: { project: ProjectDTO }) {
  const q = useQuery({
    queryKey: ['chapters', project.id],
    queryFn: () => api<{ chapters: ChapterListItem[] }>('GET', `/projects/${project.id}/chapters`),
    refetchInterval: 30_000,
  });
  if (q.isPending) return <p className="muted">{t.loading}</p>;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  if (q.data.chapters.length === 0) return <p className="muted">{t.projects.noChapters}</p>;
  return (
    <ul className="chapters">
      {[...q.data.chapters].reverse().map((c) => (
        <li key={c.id}>
          <Link to={`/chapters/${c.id}`} className="card chapter-card">
            <strong>
              {t.projects.chapter(c.number)}
              {c.title ? ` · ${c.title}` : ''}
            </strong>
            <Progress label={t.projects.clean} n={c.clean_count} total={c.page_count} />
            <Progress label={t.projects.translation} n={c.translated_count} total={c.page_count} />
            <Progress label={t.projects.typed} n={c.typed_count} total={c.page_count} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CreateProject({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [src, setSrc] = useState('ja');
  const [dst, setDst] = useState('ru');
  const [dir, setDir] = useState<'rtl' | 'ltr'>('rtl');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ project: ProjectDTO }>('POST', '/projects', { title, source_lang: src, target_lang: dst, reading_direction: dir });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      onDone(r.project.id);
    } catch (x) {
      setErr(x instanceof Error ? x.message : t.errorGeneric);
    }
  };
  return (
    <form className="card form-grid" onSubmit={(e) => void submit(e)}>
      <label>
        {t.projects.titleField}
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
      </label>
      <label>
        {t.projects.sourceLang}
        <input value={src} onChange={(e) => setSrc(e.target.value)} required minLength={2} maxLength={16} />
      </label>
      <label>
        {t.projects.targetLang}
        <input value={dst} onChange={(e) => setDst(e.target.value)} required minLength={2} maxLength={16} />
      </label>
      <label>
        {t.projects.direction}
        <select value={dir} onChange={(e) => setDir(e.target.value as 'rtl' | 'ltr')}>
          <option value="rtl">{t.projects.rtl}</option>
          <option value="ltr">{t.projects.ltr}</option>
        </select>
      </label>
      {err && <p className="error">{err}</p>}
      <button className="primary">{t.save}</button>
    </form>
  );
}
