import { Component, ElementRef, HostListener, OnInit, ViewChild, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { AuthState } from './auth';
import { environment } from '../environments/environment';

const API = environment.apiUrl;

interface ChatMessage {
  role: 'user' | 'ai';
  text: string;
  sources?: string[];
}

interface Conversation {
  id: number;
  title: string;
}

interface DocInfo {
  id: number;
  filename: string;
  chunkCount: number;
}

type Theme = 'light' | 'dark';
type AuthMode = 'login' | 'register';

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit {
  private http = inject(HttpClient);
  private sanitizer = inject(DomSanitizer);
  auth = inject(AuthState);

  @ViewChild('scrollBox') private scrollBox?: ElementRef<HTMLElement>;
  @ViewChild('box') private box?: ElementRef<HTMLTextAreaElement>;

  private abortCtl?: AbortController;

  // Auth form
  authMode = signal<AuthMode>('login');
  authError = signal('');
  authBusy = signal(false);
  authUsername = '';
  authPassword = '';

  // Chat state
  conversations = signal<Conversation[]>([]);
  activeId = signal<number | null>(null);
  sidebarOpen = signal(false);
  messages = signal<ChatMessage[]>([]);
  docs = signal<DocInfo[]>([]);
  loading = signal(false);
  copiedIndex = signal<number | null>(null);
  uploadStatus = signal('');
  uploadError = signal(false);
  input = '';

  // UI state
  theme = signal<Theme>('light');
  editingId = signal<number | null>(null);
  editTitle = '';
  pendingDelete = signal<Conversation | null>(null);

  suggestions = [
    'Summarize this PDF',
    'What are the key points?',
    'Explain it in simple words'
  ];

  constructor() {
    // When the token disappears (logout or expired token), clear everything on screen
    effect(() => {
      if (!this.auth.token()) {
        untracked(() => this.resetState());
      }
    });
  }

  ngOnInit() {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('theme');
    } catch {
      // storage may be unavailable
    }
    const system: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    this.applyTheme(saved === 'dark' || saved === 'light' ? saved : system);

    if (this.auth.token()) {
      this.initData();
    }
  }

  // ---------- Auth ----------
  switchAuthMode() {
    this.authMode.set(this.authMode() === 'login' ? 'register' : 'login');
    this.authError.set('');
  }

  submitAuth() {
    const username = this.authUsername.trim();
    const password = this.authPassword;
    if (!username || !password || this.authBusy()) return;

    this.authBusy.set(true);
    this.authError.set('');

    this.http
      .post<{ token: string; username: string }>(`${API}/auth/${this.authMode()}`, { username, password })
      .subscribe({
        next: res => {
          this.authBusy.set(false);
          this.authPassword = '';
          this.auth.login(res.token, res.username);
          this.initData();
        },
        error: err => {
          this.authBusy.set(false);
          this.authError.set(
            typeof err.error?.message === 'string' && err.error.message
              ? err.error.message
              : 'Could not reach the server. Is the backend running?'
          );
        }
      });
  }

  logout() {
    // The interceptor reads the token while subscribing, so call logout() on the server first
    this.http.post(`${API}/auth/logout`, {}).subscribe({ error: () => {} });
    this.auth.logout();
  }

  initial(): string {
    return (this.auth.username() ?? '?').charAt(0).toUpperCase();
  }

  private initData() {
    this.http.get<Conversation[]>(`${API}/conversations`).subscribe(list => {
      this.conversations.set(list);
      if (list.length) {
        this.select(list[0].id);
      } else {
        this.newChat();
      }
    });
  }

  private resetState() {
    this.abortCtl?.abort();
    this.conversations.set([]);
    this.activeId.set(null);
    this.messages.set([]);
    this.docs.set([]);
    this.loading.set(false);
    this.uploadStatus.set('');
    this.sidebarOpen.set(false);
    this.pendingDelete.set(null);
    this.editingId.set(null);
  }

  // ---------- Conversations ----------
  select(id: number) {
    this.stop();
    this.activeId.set(id);
    this.loadDocs(id);
    this.sidebarOpen.set(false);
    this.http
      .get<{ role: string; content: string }[]>(`${API}/conversations/${id}/messages`)
      .subscribe(list => {
        this.messages.set(
          list.map(m => ({ role: m.role === 'USER' ? 'user' : 'ai', text: m.content }))
        );
        this.scrollToBottom();
      });
  }

  newChat() {
    this.stop();
    this.http.post<Conversation>(`${API}/conversations`, {}).subscribe(c => {
      this.conversations.update(l => [c, ...l]);
      this.activeId.set(c.id);
      this.messages.set([]);
      this.docs.set([]);
      this.sidebarOpen.set(false);
    });
  }

  private refreshTitles() {
    this.http.get<Conversation[]>(`${API}/conversations`).subscribe(list => this.conversations.set(list));
  }

  // ---------- Rename ----------
  startRename(c: Conversation, event: Event) {
    event.stopPropagation();
    this.editTitle = c.title;
    this.editingId.set(c.id);
    setTimeout(() => {
      const el = document.getElementById('rename-input') as HTMLInputElement | null;
      el?.focus();
      el?.select();
    });
  }

  cancelRename() {
    this.editingId.set(null);
  }

  commitRename(c: Conversation) {
    // Enter and blur both call this, so only the first one should run
    if (this.editingId() !== c.id) return;
    this.editingId.set(null);

    const newTitle = this.editTitle.trim();
    if (!newTitle || newTitle === c.title) return;

    this.http.patch<Conversation>(`${API}/conversations/${c.id}`, { title: newTitle }).subscribe({
      next: updated =>
        this.conversations.update(l => l.map(x => (x.id === updated.id ? updated : x))),
      error: err => {
        console.error('Rename failed', err);
        alert('Could not rename the chat.');
      }
    });
  }

  // ---------- Delete with confirmation ----------
  askDelete(c: Conversation, event: Event) {
    event.stopPropagation();
    this.pendingDelete.set(c);
  }

  cancelDelete() {
    this.pendingDelete.set(null);
  }

  confirmDelete() {
    const c = this.pendingDelete();
    if (!c) return;
    this.pendingDelete.set(null);

    this.http.delete(`${API}/conversations/${c.id}`).subscribe(() => {
      const remaining = this.conversations().filter(x => x.id !== c.id);
      this.conversations.set(remaining);
      if (this.activeId() === c.id) {
        if (remaining.length) {
          this.select(remaining[0].id);
        } else {
          this.newChat();
        }
      }
    });
  }

  @HostListener('window:keydown.escape')
  onEscape() {
    this.cancelDelete();
  }

  // ---------- Theme ----------
  toggleTheme() {
    this.applyTheme(this.theme() === 'dark' ? 'light' : 'dark');
  }

  private applyTheme(t: Theme) {
    this.theme.set(t);
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem('theme', t);
    } catch {
      // ignore
    }
  }

  // ---------- Rendering ----------
  render(text: string): SafeHtml {
    const html = marked.parse(text, { breaks: true }) as string;
    // The text comes from an AI that can read user PDFs, so it must be sanitized
    return this.sanitizer.bypassSecurityTrustHtml(DOMPurify.sanitize(html));
  }

  copy(text: string, index: number) {
    navigator.clipboard.writeText(text).then(() => {
      this.copiedIndex.set(index);
      setTimeout(() => this.copiedIndex.set(null), 1500);
    });
  }

  // ---------- Composer ----------
  autoGrow(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  onEnter(event: KeyboardEvent) {
    if (event.shiftKey) return;
    event.preventDefault();
    this.send();
  }

  async send(preset?: string) {
    const text = (preset ?? this.input).trim();
    const conversationId = this.activeId();
    const token = this.auth.token();
    if (!text || this.loading() || conversationId === null || !token) return;

    this.messages.update(m => [...m, { role: 'user', text }, { role: 'ai', text: '' }]);
    this.input = '';
    if (this.box) this.box.nativeElement.style.height = 'auto';
    this.loading.set(true);
    this.scrollToBottom();

    const url =
      `${API}/ai/chat/stream?conversationId=${conversationId}&message=` + encodeURIComponent(text);
    const controller = new AbortController();
    this.abortCtl = controller;

    // EventSource cannot send an Authorization header, so the stream is read with fetch()
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal
      });

      if (res.status === 401) {
        this.auth.logout();
        return;
      }
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      await this.readStream(res.body);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        this.markError();
      }
    } finally {
      this.loading.set(false);
      this.refreshTitles();
    }
  }

  stop() {
    this.abortCtl?.abort();
    this.loading.set(false);
  }

  private async readStream(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      events.forEach(e => this.handleEvent(e));
    }
    if (buffer.trim()) this.handleEvent(buffer);
  }

  private handleEvent(raw: string) {
    const data = raw
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;

    let parsed: { t?: string; sources?: string[] };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    this.messages.update(m => {
      const copy = [...m];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = parsed.sources
        ? { ...last, sources: parsed.sources }
        : { ...last, text: last.text + (parsed.t ?? '') };
      return copy;
    });
    this.scrollToBottom();
  }

  private markError() {
    this.messages.update(m => {
      const copy = [...m];
      const last = copy[copy.length - 1];
      if (last && !last.text) {
        copy[copy.length - 1] = { ...last, text: 'Sorry, I could not get a response from the backend.' };
      }
      return copy;
    });
  }

  // ---------- Documents ----------
  private loadDocs(conversationId: number) {
    this.http
      .get<DocInfo[]>(`${API}/docs?conversationId=${conversationId}`)
      .subscribe(list => this.docs.set(list));
  }

  removeDoc(id: number) {
    this.http.delete(`${API}/docs/${id}`).subscribe(() => {
      this.docs.update(l => l.filter(d => d.id !== id));
    });
  }

  upload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const conversationId = this.activeId();
    if (!file || conversationId === null) return;

    const form = new FormData();
    form.append('file', file);
    this.uploadError.set(false);
    this.uploadStatus.set(`Uploading ${file.name}...`);

    this.http.post<DocInfo>(`${API}/docs/upload?conversationId=${conversationId}`, form).subscribe({
      next: doc => {
        this.uploadStatus.set('');
        this.docs.update(l => [doc, ...l]);
      },
      error: err => {
        this.uploadError.set(true);
        this.uploadStatus.set(
          typeof err.error === 'string' && err.error
            ? err.error
            : 'Upload failed. Check the backend console.'
        );
      }
    });

    input.value = '';
  }

  // ---------- Helpers ----------
  private scrollToBottom() {
    setTimeout(() => {
      const el = this.scrollBox?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
}