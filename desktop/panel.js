const draft = document.getElementById('draft');
const notesElement = document.getElementById('notes');
let draftSaveTimer = null;
let toastTimer = null;
let appState = { draft:'', notes:[] };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[char]));
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' });
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1450);
}

function renderNotes() {
  document.getElementById('noteCount').textContent = `${appState.notes.length} 条`;
  if (!appState.notes.length) {
    notesElement.innerHTML = '<div class="empty">还没有记录，写下第一条灵感吧。</div>';
    return;
  }
  notesElement.innerHTML = appState.notes.map((note) => `
    <article class="note" data-id="${escapeHtml(note.id)}">
      <button class="note-summary" type="button" aria-expanded="false">
        <span class="note-mark"></span>
        <span class="note-text">${escapeHtml(note.text)}</span>
        <time class="note-time">${escapeHtml(formatTime(note.time))}</time>
      </button>
      <div class="note-detail">
        <p class="note-full">${escapeHtml(note.text)}</p>
        <div class="note-actions"><button class="delete-note" type="button">删除记录</button></div>
      </div>
    </article>`).join('');
  notesElement.querySelectorAll('.note-summary').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('.note');
      const expanded = card.classList.toggle('expanded');
      button.setAttribute('aria-expanded', String(expanded));
    });
  });
  notesElement.querySelectorAll('.delete-note').forEach((button) => {
    button.addEventListener('click', async () => {
      const card = button.closest('.note');
      await window.nooknote.deleteNote(card.dataset.id);
      appState.notes = appState.notes.filter((note) => String(note.id) !== card.dataset.id);
      renderNotes();
      showToast('记录已删除');
    });
  });
}

async function saveNote() {
  const text = draft.value.trim();
  if (!text) return;
  const note = await window.nooknote.addNote(text);
  if (!note) return;
  appState.notes.unshift(note);
  draft.value = '';
  appState.draft = '';
  await window.nooknote.saveDraft('');
  document.getElementById('saveHint').textContent = '已收录';
  renderNotes();
  draft.focus();
  draft.setSelectionRange(0, 0);
  showToast('已收进快速收件箱');
}

draft.addEventListener('input', () => {
  appState.draft = draft.value;
  document.getElementById('saveHint').textContent = '草稿已保留';
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => window.nooknote.saveDraft(draft.value), 120);
});

draft.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    saveNote();
  }
});

document.getElementById('closeBtn').addEventListener('click', () => window.nooknote.hidePanel());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.nooknote.escape(); });
document.addEventListener('mouseenter', () => window.nooknote.panelEntered());
document.addEventListener('mouseleave', () => window.nooknote.panelLeft());
function focusDraft() {
  requestAnimationFrame(() => {
    draft.focus({ preventScroll:true });
    draft.setSelectionRange(draft.value.length, draft.value.length);
  });
}

window.nooknote.onPanelOpened(focusDraft);
window.addEventListener('focus', focusDraft);

window.nooknote.getState().then((loaded) => {
  appState = { ...loaded, notes: Array.isArray(loaded.notes) ? loaded.notes : [] };
  draft.value = appState.draft || '';
  renderNotes();
});
