import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ObjectDTO, TextChanges } from '@komaflow/contract';
import { useObjectEditor } from '../src/lib/useObjectEditor.js';
import { HttpError } from '../src/lib/api.js';
import { ConflictDialog } from '../src/components/ConflictDialog.js';
import { ExportPanel } from '../src/components/ExportPanel.js';
import { guessDevice } from '../src/screens/Login.js';

const obj = (over: Partial<ObjectDTO> = {}): ObjectDTO => ({
  id: '019b76da-a800-7000-8000-000000000001',
  page_id: '019b76da-a800-7000-8000-0000000003e8',
  order: 1,
  type: 'bubble',
  box: { x: 0, y: 0, w: 10, h: 10 },
  text_box: null,
  rotation: 0,
  geometry_ver: 1,
  source_text: 'src',
  translation: '',
  state: 'empty',
  comment: '',
  flagged: false,
  text_ver: 0,
  field_vers: {},
  updated_at: '2026-01-01T00:00:00.000Z',
  updated_by: null,
  ...over,
});

describe('useObjectEditor', () => {
  it('debounces text, sends with the base where editing began, keeps typing after save', async () => {
    const patch = vi.fn(async (_id: string, _base: number, c: TextChanges) => obj({ translation: c.translation ?? '', text_ver: 1, state: 'translated' }));
    const onObject = vi.fn();
    const { result } = renderHook(() => useObjectEditor(obj(), { patch, onObject, debounceMs: 20 }));
    act(() => result.current.set('translation', 'При'));
    act(() => result.current.set('translation', 'Привет'));
    expect(result.current.value('translation')).toBe('Привет');
    expect(result.current.status).toBe('dirty');
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(obj().id, 0, { translation: 'Привет' });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(onObject).toHaveBeenCalled();
    expect(localStorage.getItem(`komaflow:draft:${obj().id}`)).toBeNull();
  });

  it('keeps a draft in localStorage and resends it on mount', async () => {
    localStorage.setItem(`komaflow:draft:${obj().id}`, JSON.stringify({ translation: { value: 'черновик', base: 0 } }));
    const patch = vi.fn(async () => obj({ translation: 'черновик', text_ver: 1 }));
    const { result } = renderHook(() => useObjectEditor(obj(), { patch, onObject: () => {}, debounceMs: 20 }));
    expect(result.current.value('translation')).toBe('черновик');
    await waitFor(() => expect(patch).toHaveBeenCalledWith(obj().id, 0, { translation: 'черновик' }));
  });

  it('conflict: shows both versions; "keep mine" resends on the server version', async () => {
    const server = obj({ translation: 'их', text_ver: 3, state: 'translated' });
    const patch = vi
      .fn()
      .mockRejectedValueOnce(
        new HttpError(409, 'FIELD_CONFLICT', 'conflict', {
          fields: ['translation'],
          server_values: { translation: 'их' },
          object: server,
          updated_by: { id: 'u', login: 'bob', display_name: 'Боб' },
        }),
      )
      .mockResolvedValueOnce(obj({ translation: 'моё', text_ver: 4 }));
    const { result } = renderHook(() => useObjectEditor(obj(), { patch, onObject: () => {}, debounceMs: 10 }));
    act(() => result.current.set('translation', 'моё'));
    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    expect(result.current.conflict).toMatchObject({ fields: ['translation'], mine: { translation: 'моё' }, theirs: { translation: 'их' }, serverTextVer: 3 });
    act(() => result.current.resolve('mine'));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenLastCalledWith(obj().id, 3, { translation: 'моё' });
  });

  it('"accept theirs" drops the draft', async () => {
    const patch = vi.fn().mockRejectedValueOnce(
      new HttpError(409, 'FIELD_CONFLICT', 'conflict', { fields: ['comment'], server_values: { comment: 'x' }, object: obj({ comment: 'x', text_ver: 1 }), updated_by: null }),
    );
    const { result } = renderHook(() => useObjectEditor(obj(), { patch, onObject: () => {}, debounceMs: 10 }));
    act(() => result.current.set('comment', 'y'));
    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    act(() => result.current.resolve('theirs'));
    expect(result.current.dirty).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('network error keeps the draft and retries', async () => {
    const patch = vi.fn().mockRejectedValueOnce(new HttpError(0, 'NETWORK', 'offline', undefined)).mockResolvedValueOnce(obj({ comment: 'c', text_ver: 1 }));
    const { result } = renderHook(() => useObjectEditor(obj(), { patch, onObject: () => {}, debounceMs: 10 }));
    act(() => result.current.set('comment', 'c'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(localStorage.getItem(`komaflow:draft:${obj().id}`)).toContain('"c"');
    await waitFor(() => expect(result.current.status).toBe('saved'), { timeout: 3000 });
  });

  it('state and flag are sent immediately', async () => {
    const patch = vi.fn(async () => obj({ flagged: true, text_ver: 1 }));
    const { result } = renderHook(() => useObjectEditor(obj(), { patch, onObject: () => {}, debounceMs: 10_000 }));
    act(() => result.current.set('flagged', true));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(obj().id, 0, { flagged: true }));
  });
});

describe('ConflictDialog', () => {
  it('names the other user and offers three choices; merge edits both texts', () => {
    const onResolve = vi.fn();
    render(
      <ConflictDialog
        conflict={{ fields: ['translation'], mine: { translation: 'A' }, theirs: { translation: 'B' }, by: { id: 'u', login: 'bob', display_name: 'Боб' }, serverTextVer: 2 }}
        onResolve={onResolve}
      />,
    );
    expect(screen.getByText(/изменил\(а\) Боб/)).toBeTruthy();
    fireEvent.click(screen.getByText('Объединить вручную'));
    const ta = screen.getByLabelText('Объединить вручную') as HTMLTextAreaElement;
    expect(ta.value).toBe('B\nA');
    fireEvent.change(ta, { target: { value: 'AB' } });
    fireEvent.click(screen.getByText('Сохранить объединённое'));
    expect(onResolve).toHaveBeenCalledWith({ merged: 'AB' });
  });
});

describe('ExportPanel', () => {
  it('all four layers are on by default, Text included; nothing selected disables download', () => {
    const qc = new QueryClient();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ latest_export_id: null, finished_at: null, pages: [] }))));
    render(
      <QueryClientProvider client={qc}>
        <ExportPanel chapterId="019b76da-a800-7000-8000-0000000003e8" />
      </QueryClientProvider>,
    );
    for (const l of ['Raw', 'Clean', 'Notes', 'Текст']) {
      const cb = screen.getByLabelText(l) as HTMLInputElement;
      expect(cb.checked).toBe(true);
      expect(cb.disabled).toBe(false);
      fireEvent.click(cb);
    }
    expect((screen.getByText('Скачать') as HTMLButtonElement).disabled).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('login helpers', () => {
  it('guesses a device name', () => {
    expect(guessDevice('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36')).toBe('Chrome, Android');
    expect(guessDevice('Mozilla/5.0 (Windows NT 10.0) Firefox/140.0')).toBe('Firefox, Windows');
  });
});
