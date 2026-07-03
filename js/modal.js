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

  function _settle(result) {
    overlay().classList.add('hidden');
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

  return { init, isOpen, handleEscape, confirm, alert: alertBox };
})();