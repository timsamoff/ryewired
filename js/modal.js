// ── Modal ──────────────────────────────────────────────────────────────────────
// Reusable confirm/alert dialog, styled to match the app instead of native
// browser popups. Promise-based so call sites read like the native versions:
//   if (await Modal.confirm('Clear the board?')) { ... }

const Modal = (() => {
  let _resolve = null;

  const overlay    = () => document.getElementById('confirm-overlay');
  const backdrop    = () => document.getElementById('confirm-backdrop');
  const titleEl     = () => document.getElementById('confirm-title');
  const msgEl       = () => document.getElementById('confirm-message');
  const listEl      = () => document.getElementById('confirm-list');
  const okBtn       = () => document.getElementById('confirm-ok-btn');
  const cancelBtn   = () => document.getElementById('confirm-cancel-btn');

  function isOpen() {
    return !overlay().classList.contains('hidden');
  }

  function _open(message, opts) {
    overlay().classList.remove('hidden');
    titleEl().textContent = opts.title || 'Confirm';
    msgEl().textContent   = message;
    okBtn().textContent   = opts.okLabel || 'OK';
    okBtn().classList.toggle('confirm-btn-danger', !!opts.danger);
    cancelBtn().style.display = opts.cancel===false ? 'none' : '';
    okBtn().focus();
  }

  // List-picker mode: message/OK button give way to a scrollable list of
  // items; clicking one resolves the promise with that item's value.
  // Cancel/backdrop/Escape all still work the normal way (resolve false).
  function _openList(items, opts) {
    overlay().classList.remove('hidden');
    titleEl().textContent = opts.title || 'Choose';
    if (opts.message) { msgEl().textContent = opts.message; msgEl().classList.remove('hidden'); }
    else msgEl().classList.add('hidden');
    okBtn().style.display = 'none';
    cancelBtn().textContent = opts.cancelLabel || 'Cancel';
    cancelBtn().style.display = '';

    const list = listEl();
    list.classList.remove('hidden');
    list.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'confirm-list-empty';
      empty.textContent = opts.emptyLabel || 'Nothing available';
      list.appendChild(empty);
    } else {
      items.forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'confirm-list-item';
        btn.textContent = item.label;
        btn.addEventListener('click', () => _settle(item.value));
        list.appendChild(btn);
      });
    }
    cancelBtn().focus();
  }

  function _settle(result) {
    overlay().classList.add('hidden');
    // Reset back to plain confirm/alert shape so the next call (whichever
    // mode it uses) never inherits stale state from this one.
    listEl().classList.add('hidden'); listEl().innerHTML = '';
    okBtn().style.display = '';
    msgEl().classList.remove('hidden');
    if (_resolve) { const r=_resolve; _resolve=null; r(result); }
  }

  // Called from initApp() once the DOM is ready.
  function init() {
    okBtn().addEventListener('click',     () => _settle(true));
    cancelBtn().addEventListener('click', () => _settle(false));
    backdrop().addEventListener('click',  () => _settle(false));
  }

  // Escape key support — called from app.js's existing onKeyDown handler.
  function handleEscape() {
    if (!isOpen()) return false;
    _settle(false);
    return true;
  }

  function confirm(message, opts={}) {
    return new Promise(resolve => {
      _resolve = resolve;
      _open(message, opts);
    });
  }

  function alertBox(message, opts={}) {
    return new Promise(resolve => {
      _resolve = () => resolve();
      _open(message, {...opts, cancel:false, okLabel: opts.okLabel || 'OK'});
    });
  }

  // items: [{ label, value }, ...]. Resolves with the picked item's value,
  // or false if cancelled/backdrop-clicked/Escaped.
  function pickList(items, opts={}) {
    return new Promise(resolve => {
      _resolve = resolve;
      _openList(items, opts);
    });
  }

  return { init, isOpen, handleEscape, confirm, alert: alertBox, pickList };
})();