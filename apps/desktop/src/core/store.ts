import type { Workspace } from './model.js';

/**
 * Editor state: the single source of truth (docs/05 §3). The canvas only renders it.
 * Every change goes through a {@link Command} with do/undo; continuous gestures share a merge key
 * so a whole drag is one history entry. History is per chapter and capped (~200).
 */
export interface Command {
  label: string;
  /** Commands with the same non-null key, pushed one after another, merge into one entry. */
  mergeKey?: string | null;
  apply(ws: Workspace): Workspace;
  revert(ws: Workspace): Workspace;
  /** Merges a following command of the same key into this one (keeps the original "before"). */
  merge?(next: Command): Command;
}

export interface Selection {
  pageId: string | null;
  objectId: string | null;
}

export interface EditorState {
  ws: Workspace;
  sel: Selection;
  /** Bumped on every change, used for autosave and memo. */
  version: number;
}

const HISTORY_LIMIT = 200;

export class Store {
  private state: EditorState;
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners = new Set<() => void>();
  private lastMergeKey: string | null = null;

  constructor(ws: Workspace) {
    this.state = { ws, sel: { pageId: ws.pages[0]?.id ?? null, objectId: null }, version: 0 };
  }

  get = () => this.state;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(next: Partial<EditorState>) {
    this.state = { ...this.state, ...next, version: this.state.version + 1 };
    for (const l of this.listeners) l();
  }

  /** Replaces the whole workspace without history (open, download from server, publish result). */
  reset(ws: Workspace, keepSelection = true) {
    this.undoStack = [];
    this.redoStack = [];
    this.lastMergeKey = null;
    const sel = keepSelection && ws.pages.some((p) => p.id === this.state.sel.pageId) ? this.state.sel : { pageId: ws.pages[0]?.id ?? null, objectId: null };
    this.set({ ws, sel });
  }

  /** Non-undoable bookkeeping (e.g. server_markup_rev after publish). */
  patch(fn: (ws: Workspace) => Workspace) {
    this.set({ ws: fn(this.state.ws) });
  }

  exec(cmd: Command) {
    const ws = cmd.apply(this.state.ws);
    if (ws === this.state.ws) return;
    const top = this.undoStack[this.undoStack.length - 1];
    if (cmd.mergeKey && top && this.lastMergeKey === cmd.mergeKey && top.merge) {
      this.undoStack[this.undoStack.length - 1] = top.merge(cmd);
    } else {
      this.undoStack.push(cmd);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    }
    this.lastMergeKey = cmd.mergeKey ?? null;
    this.redoStack = [];
    this.set({ ws, sel: this.fixSelection(ws, this.state.sel) });
  }

  /** Ends the current gesture: the next command with the same key starts a new history entry. */
  endGesture() {
    this.lastMergeKey = null;
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    this.redoStack.push(cmd);
    this.lastMergeKey = null;
    const ws = cmd.revert(this.state.ws);
    this.set({ ws, sel: this.fixSelection(ws, this.state.sel) });
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    this.undoStack.push(cmd);
    this.lastMergeKey = null;
    const ws = cmd.apply(this.state.ws);
    this.set({ ws, sel: this.fixSelection(ws, this.state.sel) });
  }

  canUndo = () => this.undoStack.length > 0;
  canRedo = () => this.redoStack.length > 0;
  historyLabels = () => this.undoStack.map((c) => c.label);

  select(sel: Partial<Selection>) {
    const next = { ...this.state.sel, ...sel };
    if (sel.pageId && sel.pageId !== this.state.sel.pageId && sel.objectId === undefined) next.objectId = null;
    this.set({ sel: next });
  }

  private fixSelection(ws: Workspace, sel: Selection): Selection {
    const page = ws.pages.find((p) => p.id === sel.pageId) ?? ws.pages[0];
    if (!page) return { pageId: null, objectId: null };
    const obj = page.objects.some((o) => o.id === sel.objectId) ? sel.objectId : null;
    return { pageId: page.id, objectId: obj };
  }
}
