// Undo/redo. Each entry is the whole document serialized to a string.
// A document is just paths, pins and brush strokes (no pixels), so whole
// snapshots stay small and I don't have to write any diffing.
(function () {
  'use strict';
  const SF = window.SF = window.SF || {};

  class History {
    constructor(limit = 200) {
      this.limit = limit;
      this.reset(null);
    }

    reset(state) {
      this.stack = state == null ? [] : [state];
      this.index = this.stack.length - 1;
    }

    push(state) {
      if (state === this.stack[this.index]) return false;
      this.stack.length = this.index + 1;
      this.stack.push(state);
      if (this.stack.length > this.limit) this.stack.shift();
      this.index = this.stack.length - 1;
      return true;
    }

    current() { return this.stack[this.index]; }
    undo() { return this.canUndo ? this.stack[--this.index] : null; }
    redo() { return this.canRedo ? this.stack[++this.index] : null; }
    get canUndo() { return this.index > 0; }
    get canRedo() { return this.index < this.stack.length - 1; }
  }

  SF.History = History;
})();
