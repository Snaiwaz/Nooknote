const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

window.nooknote = {
  getState: () => invoke('state_get'),
  getPosition: () => invoke('state_position'),
  saveDraft: (draft) => invoke('state_save_draft', { draft }),
  addNote: (text) => invoke('note_add', { text }),
  deleteNote: (id) => invoke('note_delete', { id }),
  openPanel: () => invoke('panel_open'),
  hidePanel: () => invoke('panel_hide'),
  panelEntered: () => invoke('panel_entered'),
  panelLeft: () => invoke('panel_left'),
  triggerLeft: () => invoke('trigger_left'),
  startDrag: () => invoke('edge_drag_start'),
  dragTo: (point) => invoke('edge_drag_move', { point }),
  finishDrag: (point) => invoke('edge_drag_end', { point }),
  escape: () => invoke('panel_hide'),
  onPositionChanged: (callback) => listen('edge:position-changed', (event) => callback(event.payload)),
  onPanelOpened: (callback) => listen('panel:opened', callback),
};
